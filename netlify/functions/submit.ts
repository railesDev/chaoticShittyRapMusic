import type { Handler } from '@netlify/functions'
import multipart from 'lambda-multipart-parser'
import crypto from 'node:crypto'
import { fileTypeFromBuffer } from 'file-type'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || ''
const SIGNING_SECRET = process.env.SIGNING_SECRET || ''
const CAPTCHA_MODE = (process.env.CAPTCHA_MODE || 'none').toLowerCase()
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

async function verifyCaptcha(token: string | undefined) {
  if (CAPTCHA_MODE === 'none') return true
  if (!token) {
    if (DEBUG) console.warn('Captcha token missing')
    return false
  }
  if (CAPTCHA_MODE === 'turnstile' && TURNSTILE_SECRET) {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token })
    })
    const j = await r.json().catch(() => ({} as any))
    if (DEBUG) console.log('Turnstile verify:', j)
    return !!j.success
  }
  if (CAPTCHA_MODE === 'hcaptcha' && HCAPTCHA_SECRET) {
    const r = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: HCAPTCHA_SECRET, response: token })
    })
    const j = await r.json().catch(() => ({} as any))
    if (DEBUG) console.log('hCaptcha verify:', j)
    return !!j.success
  }
  if (DEBUG) console.warn('Captcha mode set but secret missing or unsupported mode:', CAPTCHA_MODE)
  return false
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

const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !SIGNING_SECRET) {
    return { statusCode: 500, body: 'Server not configured' }
  }

  let parsed
  try {
    parsed = await multipart.parse(event)
  } catch (e: any) {
    return { statusCode: 400, body: 'Bad form' }
  }

  // decode obfuscated fields mapping
  let fieldsMap: Record<string, string> = {}
  try {
    fieldsMap = JSON.parse(Buffer.from(parsed?.fields?.m || '', 'base64').toString('utf8'))
  } catch {}

  function getField(name: string) {
    const key = fieldsMap[name]
    return key ? parsed.fields[key] : undefined
  }

  const token = getField('token')
  const text = (getField('text') || '').trim()
  const honeypot = getField('honeypot')

  if (honeypot) return { statusCode: 400, body: 'Invalid form' }
  const captchaOk = await verifyCaptcha(token)
  if (!captchaOk) return { statusCode: 400, body: 'Captcha failed' }

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

  const cu = generateCuId()
  const caption = text ? `${cu}\n\n${sanitize(text)}` : cu

  try {
    if (content) {
      const fd = new FormData()
      if (mime?.startsWith('image/')) {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        fd.append('caption', caption)
        fd.append('parse_mode', 'HTML')
        fd.append('photo', new Blob([content], { type: mime }), filename || 'image')
        await tgApi('sendPhoto', fd)
      } else if (mime?.startsWith('audio/')) {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        fd.append('caption', caption)
        fd.append('parse_mode', 'HTML')
        fd.append('audio', new Blob([content], { type: mime }), filename || 'audio')
        await tgApi('sendAudio', fd)
      } else if (mime?.startsWith('video/')) {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        fd.append('caption', caption)
        fd.append('parse_mode', 'HTML')
        fd.append('video', new Blob([content], { type: mime }), filename || 'video')
        await tgApi('sendVideo', fd)
      } else {
        fd.append('chat_id', TELEGRAM_CHANNEL_ID)
        fd.append('caption', caption)
        fd.append('parse_mode', 'HTML')
        fd.append('document', new Blob([content], { type: mime || 'application/octet-stream' }), filename || 'file')
        await tgApi('sendDocument', fd)
      }
    } else {
      const fd = new FormData()
      fd.append('chat_id', TELEGRAM_CHANNEL_ID)
      fd.append('text', caption)
      fd.append('parse_mode', 'HTML')
      await tgApi('sendMessage', fd)
    }
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
