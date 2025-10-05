import type { Handler } from '@netlify/functions'
import multipart from 'lambda-multipart-parser'
import crypto from 'node:crypto'
import { fileTypeFromBuffer } from 'file-type'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || ''
const SIGNING_SECRET = process.env.SIGNING_SECRET || ''
const CAPTCHA_MODE = (process.env.CAPTCHA_MODE || 'turnstile').toLowerCase()
const DEBUG = process.env.DEBUG === '1'
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || ''
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET || ''
const MAX_ATTACHMENT_SIZE_MB = parseInt(process.env.MAX_ATTACHMENT_SIZE_MB || '6', 10)
const RATE_LIMIT_MINUTES = parseInt(process.env.RATE_LIMIT_MINUTES || '1', 10)

function b64e(buf: Buffer) {
  return buf.toString('base64url')
}

function sign(ts: number) {
  const h = crypto.createHmac('sha256', SIGNING_SECRET)
  h.update(String(ts))
  const sig = b64e(h.digest())
  return `${ts}.${sig}`
}

function verify(token: string) {
  try {
    const [tsStr, sig] = token.split('.')
    const ts = parseInt(tsStr, 10)
    if (!ts || !sig) return { ok: false, why: 'bad' }
    if (sign(ts) !== token) return { ok: false, why: 'sig' }
    if (Date.now() / 1000 - ts < RATE_LIMIT_MINUTES * 60) return { ok: false, why: 'rate' }
    return { ok: true }
  } catch {
    return { ok: false, why: 'bad' }
  }
}

function sanitize(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function generateCuId() {
  const ts = Math.floor(Date.now() / 1000).toString(36)
  const rnd = crypto.randomBytes(2).toString('hex')
  return `cu-${ts}${rnd}`
}

type CaptchaResult = { ok: boolean; details?: any; reason?: string }

async function verifyCaptcha(token: string | undefined): Promise<CaptchaResult> {
  if (CAPTCHA_MODE === 'none') return { ok: true }
  if (!token) return { ok: false, reason: 'missing-token' }
  if (CAPTCHA_MODE === 'turnstile' && TURNSTILE_SECRET) {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token })
    })
    const j = await r.json().catch(() => ({} as any))
    if (DEBUG) console.log('Turnstile verify:', j)
    return { ok: !!j.success, details: j }
  }
  if (CAPTCHA_MODE === 'hcaptcha' && HCAPTCHA_SECRET) {
    const r = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: HCAPTCHA_SECRET, response: token })
    })
    const j = await r.json().catch(() => ({} as any))
    if (DEBUG) console.log('hCaptcha verify:', j)
    return { ok: !!j.success, details: j }
  }
  return { ok: false, reason: 'misconfigured' }
}

function basicModeration(text: string) {
  const t = (text || '').toLowerCase()
  if (t.length > 4000) return 'Слишком длинный текст (>4000)'
  const bad = ['суицид', 'бомба', 'террор', 'насилие', 'экстремизм']
  if (bad.some(w => t.includes(w))) return 'Сообщение содержит запрещённые слова'
  const links = (t.match(/https?:\/\//g) || []).length + (t.match(/www\./g) || []).length
  if (links > 2) return 'Слишком много ссылок в сообщении'
  return null
}

async function tgApi(method: string, form?: FormData) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`
  const r = await fetch(url, { method: 'POST', body: form })
  if (!r.ok) throw new Error(`tg ${method} ${r.status}`)
  const j = await r.json()
  if (!j.ok) throw new Error(`tg error: ${JSON.stringify(j)}`)
  return j.result
}

async function getNumericChatId(): Promise<number> {
  // If env already numeric, use it
  const idStr = TELEGRAM_CHANNEL_ID.trim()
  if (/^-?\d+$/.test(idStr)) return Number(idStr)
  const fd = new FormData()
  fd.append('chat_id', TELEGRAM_CHANNEL_ID)
  const chat = await tgApi('getChat', fd)
  return chat.id as number
}

async function computeNextCounter(): Promise<number> {
  // Try to read last cu-N from recent updates for this bot in this channel
  const chatIdNum = await getNumericChatId()
  const fd = new FormData()
  fd.append('limit', '100')
  fd.append('timeout', '0')
  fd.append('allowed_updates', JSON.stringify(['channel_post', 'edited_channel_post']))
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`
  const r = await fetch(url, { method: 'POST', body: fd })
  let last = 0
  try {
    const j = await r.json()
    if (j.ok && Array.isArray(j.result)) {
      for (let i = j.result.length - 1; i >= 0; i--) {
        const u = j.result[i]
        const msg = (u.channel_post || u.edited_channel_post)
        if (msg && msg.chat && msg.chat.id === chatIdNum) {
          const text = (msg.caption || msg.text || '') as string
          const m = text.match(/\bcu-(\d+)\b/i)
          if (m) { last = Math.max(last, parseInt(m[1], 10)); if (last) break }
        }
      }
    }
  } catch {}
  return last + 1 || 1
}

async function getChatInfo(): Promise<any> {
  const fd = new FormData()
  fd.append('chat_id', TELEGRAM_CHANNEL_ID)
  return tgApi('getChat', fd)
}

function extractCounterFromDesc(desc: string | undefined): number {
  if (!desc) return 0
  const mRu = desc.match(/Всего\s+сообщений:\s*(\d+)/i)
  if (mRu) return parseInt(mRu[1], 10)
  const m1 = desc.match(/\bcu-\s*(\d+)\b/i)
  if (m1) return parseInt(m1[1], 10)
  const m2 = desc.match(/\bcu:\s*(\d+)\b/i)
  if (m2) return parseInt(m2[1], 10)
  return 0
}

function upsertCounterInDesc(desc: string | undefined, n: number): string {
  let base = (desc || '').trim()
  const target = `Всего сообщений: ${n}`
  if (!base) return target
  if (/Всего\s+сообщений:\s*\d+/i.test(base)) {
    return base.replace(/Всего\s+сообщений:\s*\d+/i, target)
  }
  // Fallback legacy tags -> replace with RU form
  if (/\bcu:\s*\d+\b/i.test(base)) {
    return base.replace(/\bcu:\s*\d+\b/i, target)
  }
  if (/\bcu-\s*\d+\b/i.test(base)) {
    return base.replace(/\bcu-\s*\d+\b/i, target)
  }
  const suffix = ` • ${target}`
  const limit = 255
  if (base.length + suffix.length > limit) {
    base = base.slice(0, limit - suffix.length - 1).trimEnd()
  }
  return base + suffix
}

const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !SIGNING_SECRET) {
    return { statusCode: 500, body: 'Server not configured' }
  }

  let parsed: any
  try {
    parsed = await multipart.parse(event)
  } catch (e: any) {
    return { statusCode: 400, body: 'Bad form' }
  }
  // Ensure safe shapes
  if (!parsed || typeof parsed !== 'object') parsed = { fields: {}, files: [] }
  if (!parsed.fields) parsed.fields = {}
  if (!parsed.files) parsed.files = []

  // decode obfuscated fields mapping
  let fieldsMap: Record<string, string> = {}
  try {
    const mRaw = (parsed.fields && parsed.fields.m) || (parsed as any)['m']
    if (typeof mRaw === 'string' && mRaw) {
      fieldsMap = JSON.parse(Buffer.from(mRaw, 'base64').toString('utf8'))
    }
  } catch (e) {
    if (DEBUG) console.warn('Failed to decode fields map:', String(e))
  }

  function getField(name: string) {
    const key = fieldsMap[name]
    const v = key ? parsed.fields[key] : (parsed.fields ? parsed.fields[name] : undefined)
    if (v !== undefined) return v
    // Fallbacks for robustness
    if (name === 'token') {
      return (
        (parsed.fields && (parsed.fields['token'] as string | undefined)) ||
        (parsed.fields && (parsed.fields['cf-turnstile-response'] as string | undefined)) ||
        (parsed.fields && (parsed.fields['h-captcha-response'] as string | undefined)) ||
        (parsed as any)['token'] ||
        (parsed as any)['cf-turnstile-response'] ||
        (parsed as any)['h-captcha-response'] ||
        // also accept via header override
        (event.headers && (event.headers['x-turnstile-token'] || (event.headers as any)['X-Turnstile-Token']))
      )
    }
    return (parsed as any)[name]
  }

  const token = getField('token') as string | undefined
  let text = String(getField('text') || '').trim()
  const honeypot = getField('honeypot')

  if (honeypot) return { statusCode: 400, body: 'Invalid form' }
  if (DEBUG) {
    const keys = new Set<string>()
    if (parsed && typeof parsed === 'object') {
      Object.keys(parsed).forEach(k => keys.add(k))
    }
    if (parsed.fields && typeof parsed.fields === 'object') {
      Object.keys(parsed.fields).forEach(k => keys.add('fields.' + k))
    }
    console.log('Form keys:', Array.from(keys))
    console.log('Token candidates:', {
      direct: (parsed as any)['token']?.toString?.().slice(0, 10),
      directCF: (parsed as any)['cf-turnstile-response']?.toString?.().slice(0, 10),
      fToken: parsed.fields && (parsed.fields['token'] as any)?.toString?.().slice(0, 10),
      fCF: parsed.fields && (parsed.fields['cf-turnstile-response'] as any)?.toString?.().slice(0, 10)
    })
  }

  const captcha = await verifyCaptcha(token)
  if (!captcha.ok) {
    if (DEBUG) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'captcha_failed', mode: CAPTCHA_MODE, debug: captcha })
      }
    }
    return { statusCode: 400, body: 'Captcha failed' }
  }

  const cookie = event.headers.cookie || ''
  const match = cookie.match(/sub_token=([^;]+)/)
  if (match) {
    const { ok, why } = verify(match[1])
    if (!ok && why === 'rate') {
      return { statusCode: 429, body: 'Слишком часто. Подождите немного.' }
    }
  }

  const reason = basicModeration(text)
  if (reason) return { statusCode: 400, body: reason }
  // Make sure we keep user's text; if empty, try top-level again or fallback to filename
  if (!text) {
    if (parsed && typeof parsed === 'object') {
      const direct = (parsed as any)['text']
      if (typeof direct === 'string' && direct.trim()) text = direct.trim()
    }
  }

  // Handle file (single optional)
  const file = (parsed.files || [])[0]
  let content: Buffer | undefined
  let filename: string | undefined
  let mime: string | undefined
  if (file) {
    content = file.content as Buffer
    filename = file.filename
    mime = file.contentType
    if (!content || content.length === 0) {
      return { statusCode: 400, body: 'Пустой файл' }
    }
    const max = MAX_ATTACHMENT_SIZE_MB * 1024 * 1024
    if (content.length > max) {
      return { statusCode: 400, body: `Файл слишком большой (макс ${MAX_ATTACHMENT_SIZE_MB}MB)` }
    }
    // try detect mime by signature
    const sig = await fileTypeFromBuffer(content).catch(() => null)
    if (sig?.mime) mime = sig.mime
    // basic blocklist
    const blocked = ['application/x-msdownload', 'application/x-sh', 'application/java-archive']
    if (mime && blocked.some(p => mime.startsWith(p))) {
      return { statusCode: 400, body: 'Этот тип файлов запрещён' }
    }
  }

  const captionBase = sanitize(text)
  // Determine counter: try updates, else channel description
  let cuNumber = await computeNextCounter()
  if (!cuNumber || cuNumber < 1) {
    try {
      const chat = await getChatInfo()
      const fromDesc = extractCounterFromDesc(chat?.description)
      cuNumber = (fromDesc || 0) + 1
      if (!cuNumber) cuNumber = 1
    } catch {}
  }
  const finalPrefix = `cu-${cuNumber}`

  try {
    if (content) {
      const fd = new FormData()
      if (mime?.startsWith('image/')) {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        fd.append('caption', captionBase ? `${finalPrefix}\n\n${captionBase}` : `${finalPrefix}`)
        fd.append('parse_mode', 'HTML')
        fd.append('photo', new Blob([content], { type: mime }), filename || 'image')
        await tgApi('sendPhoto', fd)
      } else if (mime?.startsWith('audio/')) {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        fd.append('caption', captionBase ? `${finalPrefix}\n\n${captionBase}` : `${finalPrefix}`)
        fd.append('parse_mode', 'HTML')
        fd.append('audio', new Blob([content], { type: mime }), filename || 'audio')
        await tgApi('sendAudio', fd)
      } else if (mime?.startsWith('video/')) {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        fd.append('caption', captionBase ? `${finalPrefix}\n\n${captionBase}` : `${finalPrefix}`)
        fd.append('parse_mode', 'HTML')
        fd.append('video', new Blob([content], { type: mime }), filename || 'video')
        await tgApi('sendVideo', fd)
      } else {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        fd.append('caption', captionBase ? `${finalPrefix}\n\n${captionBase}` : `${finalPrefix}`)
        fd.append('parse_mode', 'HTML')
        fd.append('document', new Blob([content], { type: mime || 'application/octet-stream' }), filename || 'file')
        await tgApi('sendDocument', fd)
      }
    } else {
      const fd = new FormData()
      fd.append('chat_id', TELEGRAM_CHANNEL_ID)
      fd.append('text', captionBase ? `${finalPrefix}\n\n${captionBase}` : `${finalPrefix}`)
      fd.append('parse_mode', 'HTML')
      await tgApi('sendMessage', fd)
    }

    // Persist last counter in channel description (best-effort)
    try {
      const chat = await getChatInfo()
      const newDesc = upsertCounterInDesc(chat?.description, cuNumber)
      const fdDesc = new FormData()
      fdDesc.append('chat_id', TELEGRAM_CHANNEL_ID)
      fdDesc.append('description', newDesc)
      await tgApi('setChatDescription', fdDesc)
    } catch {}
  } catch (e: any) {
    return { statusCode: 502, body: `Telegram error: ${e?.message || 'unknown'}` }
  }

  const ts = Math.floor(Date.now() / 1000)
  const tokenNew = sign(ts)
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `sub_token=${tokenNew}; Max-Age=${365*24*60*60}; Path=/; HttpOnly; SameSite=Lax`
    },
    body: JSON.stringify({ ok: true })
  }
}

export { handler }
