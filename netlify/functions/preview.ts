import type { Handler } from '@netlify/functions'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || ''
const COUNTER_STORAGE_CHAT_ID = process.env.COUNTER_STORAGE_CHAT_ID || ''

function sanitize(text: string) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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
  try {
    const q = event.queryStringParameters || {}
    let idRaw = q.cu || q.id || ''
    if (Array.isArray(idRaw)) idRaw = idRaw[0]
    const m = String(idRaw).match(/(\d+)/)
    if (!m) return { statusCode: 400, body: 'bad id' }
    const msgId = parseInt(m[1], 10)

    // Forward message to storage to retrieve text/caption, then delete it
    const fwd = new FormData()
    fwd.append('chat_id', COUNTER_STORAGE_CHAT_ID || TELEGRAM_CHANNEL_ID)
    fwd.append('from_chat_id', TELEGRAM_CHANNEL_ID)
    fwd.append('message_id', String(msgId))
    fwd.append('disable_notification', 'true')
    const forwarded = await tgApi('forwardMessage', fwd)

    const text = forwarded?.text || forwarded?.caption || ''

    // Try to delete the forwarded message to keep storage clean
    try {
      const del = new FormData()
      del.append('chat_id', COUNTER_STORAGE_CHAT_ID || TELEGRAM_CHANNEL_ID)
      del.append('message_id', String(forwarded?.message_id))
      await tgApi('deleteMessage', del)
    } catch {}

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: true, id: msgId, text: sanitize(text) })
    }
  } catch (e: any) {
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false }) }
  }
}

export { handler }

