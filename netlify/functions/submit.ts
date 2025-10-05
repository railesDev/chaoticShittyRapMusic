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
const RATE_LIMIT_SECONDS_ENV = parseInt(process.env.RATE_LIMIT_SECONDS || '10', 10)
const RATE_WINDOW_SECONDS = Number.isFinite(RATE_LIMIT_SECONDS_ENV) ? RATE_LIMIT_SECONDS_ENV : (RATE_LIMIT_MINUTES * 60)

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
    if (Date.now() / 1000 - ts < RATE_WINDOW_SECONDS) return { ok: false, why: 'rate' }
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

async function editText(chatId: string, messageId: number, text: string) {
  const fd = new FormData()
  fd.append('chat_id', chatId)
  fd.append('message_id', String(messageId))
  fd.append('text', text)
  fd.append('parse_mode', 'HTML')
  return tgApi('editMessageText', fd)
}

async function editCaption(chatId: string, messageId: number, caption: string) {
  const fd = new FormData()
  fd.append('chat_id', chatId)
  fd.append('message_id', String(messageId))
  fd.append('caption', caption)
  fd.append('parse_mode', 'HTML')
  return tgApi('editMessageCaption', fd)
}

// Counter/description updates removed — numbering is via message_id only.

async function getChatInfo(): Promise<any> {
  const fd = new FormData()
  fd.append('chat_id', TELEGRAM_CHANNEL_ID)
  return tgApi('getChat', fd)
}

// No channel description parsing/updating anymore

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
  const replyRaw = String(getField('reply_to') || '').trim()
  const replyMatch = replyRaw.match(/cu[-: ]?(\d+)/i)
  const replyToMessageId = replyMatch ? parseInt(replyMatch[1], 10) : undefined
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
    // Drop video support explicitly
    if (mime && mime.startsWith('video/')) {
      return { statusCode: 400, body: 'Видео не поддерживается' }
    }
  }

  const captionBase = sanitize(text)
  // No storage/description counter — we only use message_id

  try {
    if (content) {
      const fd = new FormData()
      if (mime?.startsWith('image/')) {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        if (captionBase) fd.append('caption', captionBase)
        fd.append('parse_mode', 'HTML')
        if (replyToMessageId !== undefined) { fd.append('reply_to_message_id', String(replyToMessageId)); }
        fd.append('photo', new Blob([content], { type: mime }), filename || 'image')
        const sent = await tgApi('sendPhoto', fd)
        const id = sent.message_id as number
        const finalCaption = captionBase ? `cu-${id}\n\n${captionBase}` : `cu-${id}`
        await editCaption(TELEGRAM_CHANNEL_ID, id, finalCaption)
      } else if (mime?.startsWith('audio/')) {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        if (captionBase) fd.append('caption', captionBase)
        fd.append('parse_mode', 'HTML')
        if (replyToMessageId !== undefined) { fd.append('reply_to_message_id', String(replyToMessageId)); }
        fd.append('audio', new Blob([content], { type: mime }), filename || 'audio')
        const sent = await tgApi('sendAudio', fd)
        const id = sent.message_id as number
        const finalCaption = captionBase ? `cu-${id}\n\n${captionBase}` : `cu-${id}`
        await editCaption(TELEGRAM_CHANNEL_ID, id, finalCaption)
      } else if (mime?.startsWith('video/')) {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        if (captionBase) fd.append('caption', captionBase)
        fd.append('parse_mode', 'HTML')
        if (replyToMessageId !== undefined) { fd.append('reply_to_message_id', String(replyToMessageId)); }
        fd.append('video', new Blob([content], { type: mime }), filename || 'video')
        const sent = await tgApi('sendVideo', fd)
        const id = sent.message_id as number
        const finalCaption = captionBase ? `cu-${id}\n\n${captionBase}` : `cu-${id}`
        await editCaption(TELEGRAM_CHANNEL_ID, id, finalCaption)
      } else {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        if (captionBase) fd.append('caption', captionBase)
        fd.append('parse_mode', 'HTML')
        if (replyToMessageId !== undefined) { fd.append('reply_to_message_id', String(replyToMessageId)); }
        fd.append('document', new Blob([content], { type: mime || 'application/octet-stream' }), filename || 'file')
        const sent = await tgApi('sendDocument', fd)
        const id = sent.message_id as number
        const finalCaption = captionBase ? `cu-${id}\n\n${captionBase}` : `cu-${id}`
        await editCaption(TELEGRAM_CHANNEL_ID, id, finalCaption)
      }
    } else {
      const fd = new FormData()
      fd.append('chat_id', TELEGRAM_CHANNEL_ID)
      fd.append('text', captionBase || '...')
      fd.append('parse_mode', 'HTML')
      if (replyToMessageId !== undefined) { fd.append('reply_to_message_id', String(replyToMessageId)); }
      const sent = await tgApi('sendMessage', fd)
      const id = sent.message_id as number
      const finalText = captionBase ? `cu-${id}\n\n${captionBase}` : `cu-${id}`
      await editText(TELEGRAM_CHANNEL_ID, id, finalText)
    }

    // No channel description updates
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/reply message not found/i.test(msg) || /REPLY_MESSAGE_NOT_FOUND/i.test(msg)) {
      return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'reply_not_found' }) }
    }
    return { statusCode: 502, body: `Telegram error: ${msg || 'unknown'}` }
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
