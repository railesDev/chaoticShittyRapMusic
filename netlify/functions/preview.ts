import type { Handler } from '@netlify/functions'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || ''
const PREVIEW_CHAT_ID = process.env.PREVIEW_CHAT_ID || ''

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
    
    // Preferred robust path: forward the message to a private preview chat and read its content
    if (PREVIEW_CHAT_ID) {
      try {
        const fwd = new FormData()
        fwd.append('chat_id', PREVIEW_CHAT_ID)
        fwd.append('from_chat_id', TELEGRAM_CHANNEL_ID)
        fwd.append('message_id', String(msgId))
        fwd.append('disable_notification', 'true')
        const forwarded = await tgApi('forwardMessage', fwd)

        let text = forwarded?.caption || forwarded?.text || ''
        let kind = ''
        if (forwarded?.photo) kind = 'Фото'
        else if (forwarded?.audio) kind = 'Аудио'
        else if (forwarded?.voice) kind = 'Голосовое'
        else if (forwarded?.document) kind = 'Документ'
        else if (forwarded?.sticker) kind = 'Стикер'
        else if (forwarded?.video) kind = 'Видео'
        if (text) text = text.replace(/^\s*cu-\d+\s*\n?\n?/i, '')
        let preview = text
        if (kind) preview = `${kind}${preview ? `\n${preview}` : ''}`

        // cleanup forwarded message
        try {
          const del = new FormData()
          del.append('chat_id', PREVIEW_CHAT_ID)
          del.append('message_id', String(forwarded?.message_id))
          await tgApi('deleteMessage', del)
        } catch {}

        if (preview) {
          return { statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ok: true, id: msgId, text: sanitize(preview).slice(0,200) }) }
        }
      } catch {}
    }

    // Fallback: recent updates (may miss older messages)
    const fd = new FormData()
    fd.append('limit', '100')
    fd.append('timeout', '0')
    fd.append('allowed_updates', JSON.stringify(['channel_post','edited_channel_post']))
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`
    const r = await fetch(url, { method: 'POST', body: fd })
    const j = await r.json().catch(()=>({ ok:false }))
    let text = ''
    let kind = ''
    if (j.ok && Array.isArray(j.result)) {
      for (const u of j.result) {
        const msg = u.channel_post || u.edited_channel_post
        if (msg && msg.message_id === msgId) {
          if (msg.photo) kind = 'Фото'
          else if (msg.audio) kind = 'Аудио'
          else if (msg.voice) kind = 'Голосовое'
          else if (msg.document) kind = 'Документ'
          else if (msg.sticker) kind = 'Стикер'
          else if (msg.video) kind = 'Видео'
          text = msg.caption || msg.text || ''
          break
        }
      }
    }
    if (text) text = text.replace(/^\s*cu-\d+\s*\n?\n?/i, '')
    let preview = text
    if (kind) preview = `${kind}${preview ? `\n${preview}` : ''}`
    if (!preview) return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false }) }
    return { statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ok: true, id: msgId, text: sanitize(preview).slice(0,200) }) }
  } catch (e: any) {
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false }) }
  }
}

export { handler }
