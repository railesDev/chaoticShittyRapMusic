import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Paperclip, Send, Reply, Trash2 } from 'lucide-react'

type SubmitState = 'idle' | 'submitting' | 'done' | 'error'

const OBF_KEYS = [
  'f', 'data', 'payload', 'z', 'x', 'o', 'k'
] as const

function randomKey() {
  return OBF_KEYS[Math.floor(Math.random() * OBF_KEYS.length)] + '_' + Math.random().toString(36).slice(2, 7)
}

function buildFields() {
  const map = new Map<string, string>()
  map.set('text', randomKey())
  map.set('token', randomKey())
  map.set('honeypot', randomKey())
  map.set('file', randomKey())
  return map
}

const API_BASE = (import.meta as any).env.VITE_API_BASE_URL || '/api'
// Site key is now fetched from backend runtime config

declare global {
  interface Window {
    turnstile?: any
  }
}

export default function App() {
  const [state, setState] = useState<SubmitState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [captchaToken, setCaptchaToken] = useState<string>('')
  const [siteKey, setSiteKey] = useState<string>('')
  const [fields] = useState(buildFields)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const hpRef = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState('')
  const [captchaMode, setCaptchaMode] = useState<'turnstile' | 'hcaptcha' | 'none'>('turnstile')
  const widgetIdRef = useRef<any>(null)
  // Captcha token lifecycle
  const tokenVersionRef = useRef(0)
  const lastUsedTokenVersionRef = useRef(-1)
  const waitResolveRef = useRef<((t: string) => void) | null>(null)
  const waitTimerRef = useRef<number | null>(null)

  const reset = useCallback(() => {
    setState('idle'); setError(null); setCaptchaToken(''); setText('')
    if (fileRef.current) fileRef.current.value = ''
    if (window.turnstile) {
      try { window.turnstile.reset(widgetIdRef.current) } catch {}
    }
  }, [])

  const onLoadTurnstile = useCallback(() => {
    if (!siteKey || !window.turnstile) return
    const id = window.turnstile.render('#cf-turnstile', {
      sitekey: siteKey,
      callback: (token: string) => {
        setCaptchaToken(token)
        tokenVersionRef.current += 1
        if (waitResolveRef.current) {
          waitResolveRef.current(token)
          waitResolveRef.current = null
          if (waitTimerRef.current) {
            window.clearTimeout(waitTimerRef.current)
            waitTimerRef.current = null
          }
        }
      },
      'error-callback': () => setCaptchaToken('')
    })
    widgetIdRef.current = id
  }, [siteKey])

  React.useEffect(() => {
    // fetch runtime config for captcha site key
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/config`)
        if (res.ok) {
          const j = await res.json()
          if (j?.turnstile_site_key) setSiteKey(j.turnstile_site_key)
          if (j?.captcha) setCaptchaMode(j.captcha)
        }
      } catch {}
    })()
    const id = setInterval(() => {
      if (window.turnstile) {
        clearInterval(id)
        onLoadTurnstile()
      }
    }, 200)
    return () => clearInterval(id)
  }, [onLoadTurnstile])

  async function requireCaptchaToken(): Promise<string> {
    if (captchaMode === 'none') return ''
    // if we already have a fresh token not yet used
    if (captchaToken && tokenVersionRef.current > lastUsedTokenVersionRef.current) {
      return captchaToken
    }
    // trigger a fresh token and wait for callback
    const ts: any = (window as any).turnstile
    if (!ts) throw new Error('Капча недоступна')
    try { ts.reset(widgetIdRef.current) } catch {}
    return await new Promise<string>((resolve, reject) => {
      waitResolveRef.current = resolve
      waitTimerRef.current = window.setTimeout(() => {
        waitResolveRef.current = null
        reject(new Error('Капча не подтверждена'))
      }, 10000)
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (hpRef.current?.value) {
      setError('Ошибка валидации')
      return
    }
    let tokenToSend = ''
    try {
      tokenToSend = await requireCaptchaToken()
    } catch (err: any) {
      setError(err?.message || 'Подтвердите капчу')
      return
    }
    setState('submitting')
    try {
      const fd = new FormData()
      fd.set(fields.get('text')!, text)
      fd.set(fields.get('token')!, tokenToSend || '')
      fd.set(fields.get('honeypot')!, hpRef.current?.value || '')
      // Plain fallbacks for robustness
      fd.set('text', text)
      // Add non-obfuscated fallbacks to improve compatibility
      if (tokenToSend) {
        fd.set('token', tokenToSend)
        fd.set('cf-turnstile-response', tokenToSend)
      }
      if (replyInput.trim()) fd.set('reply_to', replyInput.trim())
      if (fileRef.current?.files?.[0]) fd.set(fields.get('file')!, fileRef.current.files[0])

      // Wrap fields map (light obfuscation)
      fd.set('m', btoa(JSON.stringify(Object.fromEntries(fields))))

      const headers: Record<string, string> = {}
      if (tokenToSend) headers['X-Turnstile-Token'] = tokenToSend
      const res = await fetch(`${API_BASE}/submit`, {
        method: 'POST',
        body: fd,
        headers,
        credentials: 'include'
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        let j: any = null
        try { j = txt ? JSON.parse(txt) : null } catch {}
        if (j?.error === 'captcha_failed') {
          // mark old token as used and request a fresh token next time
          lastUsedTokenVersionRef.current = tokenVersionRef.current
          throw new Error('Капча истекла, попробуйте ещё раз')
        }
        throw new Error(j ? JSON.stringify(j) : (txt || 'Ошибка отправки'))
      }
      // mark token as used to force refresh next submit
      lastUsedTokenVersionRef.current = tokenVersionRef.current
      setState('done')
    } catch (e: any) {
      setError(e?.message || 'Ошибка отправки')
      setState('error')
    }
  }

  React.useEffect(() => {
    if (state === 'done' || state === 'error') {
      const t = setTimeout(() => setState('idle'), 10000)
      return () => clearTimeout(t)
    }
  }, [state])

  // Styles
  const container: React.CSSProperties = { maxWidth: 900, margin: '0 auto', padding: '0 16px' }
  const headerWrap: React.CSSProperties = { position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg)', padding: '20px 0 12px' }
  const title: React.CSSProperties = { fontSize: 'clamp(32px, 6vw, 56px)', fontWeight: 500, margin: '8px 0 6px', letterSpacing: -0.5, lineHeight: 1.05 }
  const subtitle: React.CSSProperties = { color: 'var(--muted)', margin: 0, fontSize: 18, fontWeight: 500 }
  const contentWrap: React.CSSProperties = { paddingTop: 8, paddingBottom: 120, minHeight: 'calc(100vh - 180px)' }
  const composerWrap: React.CSSProperties = { position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30, background: 'var(--bg)', padding: '8px 12px calc(8px + env(safe-area-inset-bottom))' }
  const composerInner: React.CSSProperties = { maxWidth: 900, margin: '0 auto', display: 'flex', gap: 10, alignItems: 'flex-end' }
  const label: React.CSSProperties = { color: 'var(--muted)', marginBottom: 8, fontWeight: 500 }
  const textareaStyle: React.CSSProperties = { width: '100%', padding: 16, borderRadius: 16, border: '1px solid var(--border)', background: '#0f0f14', color: 'var(--text)', outline: 'none', fontSize: 16, resize: 'none', boxShadow: '0 0 0 1px rgba(255,255,255,0.04) inset' }
  const row: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }
  const primaryBtn: React.CSSProperties = { width: 52, height: 52, borderRadius: 18, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
  const ghostBtn: React.CSSProperties = { padding: '10px 14px', borderRadius: 999, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontWeight: 500, cursor: 'pointer' }
  const attachBtn: React.CSSProperties = { width: 52, height: 52, borderRadius: 18, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center' }
  const chip: React.CSSProperties = { padding: '6px 12px', borderRadius: 999, background: '#BBE3E6', color: '#0b0b0f', fontWeight: 500, display: 'inline-block' }
  const replyInputStyle: React.CSSProperties = { flex: '0 0 260px', padding: '12px 16px', borderRadius: 18, border: 'none', background: '#0f0f14', color: 'var(--text)', outline: 'none', boxShadow: '0 0 0 1px rgba(255,255,255,0.06) inset', fontSize: 20 }

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewKind, setPreviewKind] = useState<'image'|'audio'|'video'|'file'|null>(null)
  const [replyInput, setReplyInput] = useState('')
  const [replyPreview, setReplyPreview] = useState<string>('')
  const [replyOpen, setReplyOpen] = useState(true)

  const onPickFile = useCallback(() => fileRef.current?.click(), [])
  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) { setPreviewUrl(null); setPreviewKind(null); return }
    if (f.type.startsWith('video/')) { alert('Видео не поддерживается'); if (fileRef.current) fileRef.current.value=''; return }
    const url = URL.createObjectURL(f)
    setPreviewUrl(url)
    if (f.type.startsWith('image/')) setPreviewKind('image')
    else if (f.type.startsWith('audio/')) setPreviewKind('audio')
    else setPreviewKind('file')
  }, [])
  const clearFile = useCallback(() => {
    if (fileRef.current) fileRef.current.value = ''
    setPreviewUrl(null); setPreviewKind(null)
  }, [])

  React.useEffect(() => {
    const m = replyInput.match(/(?:cu[-: ]?)?(\d+)/i)
    if (!m) { setReplyPreview(''); return }
    const id = m[1]
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const r = await fetch(`${API_BASE}/preview?cu=${id}`, { signal: ctrl.signal })
        if (!r.ok) return
        const j = await r.json()
        if (j?.ok && String(j.id) === id) setReplyPreview(j.text || '')
      } catch {}
    })()
    return () => ctrl.abort()
  }, [replyInput])

  return (
    <div style={container}>
      <div style={headerWrap}>
        <div style={chip}>CU Pulse</div>
        <h1 style={title}>Новый анонимный пост</h1>
        <p style={subtitle}>Используй с умом</p>
      </div>

      <div style={contentWrap}>
        {previewUrl && (
          <div style={{ marginTop: 16, position: 'relative' }}>
            {previewKind === 'image' && <img src={previewUrl} alt="preview" style={{ width: '100%', maxHeight: 360, objectFit: 'cover', borderRadius: 18, border: '1px solid var(--border)' }} />}
            {previewKind === 'audio' && <audio controls src={previewUrl} style={{ width: '100%' }} />}
            {previewKind === 'file' && <div style={{ color: 'var(--muted)' }}>Файл готов к отправке</div>}
            <button type="button" onClick={clearFile} title="Удалить" style={{ position: 'absolute', right: 8, bottom: 8, background: 'rgba(0,0,0,0.5)', border: '1px solid var(--border)', borderRadius: 12, padding: 8, color: 'var(--accent)' }}>
              <Trash2 size={18} />
            </button>
          </div>
        )}
      </div>

      <div style={composerWrap}>
          <div style={{ maxWidth: 900, margin: '0 auto 8px' }}>
            <div style={label}>Ответить на</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--muted)' }}>
            <Reply size={24} color={'var(--accent)'} />
            <input id="reply-input" value={replyInput} onChange={e=>setReplyInput(e.target.value)} placeholder="cu-XXX" style={replyInputStyle} />
            </div>
            {replyInput && (
              <div style={{ marginTop: 8, borderLeft: '3px solid var(--accent)', paddingLeft: 12 }}>
                <div style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{replyPreview ? replyPreview.slice(0,200) : 'Сообщение не найдено'}</div>
              </div>
            )}
          </div>

        <form onSubmit={handleSubmit} style={composerInner}>
          <button type="button" onClick={onPickFile} title="Вложение" style={attachBtn}><Paperclip size={20} /></button>
          <textarea value={text} onChange={(e)=>{setText(e.target.value); const t=e.target as HTMLTextAreaElement; t.style.height='auto'; t.style.height=Math.min(160, t.scrollHeight)+"px"}} placeholder="Поделись тем, что важно" rows={2} style={{...textareaStyle, flex: 1, height: 56, borderRadius: 24 }} />
          <button aria-label="Отправить" disabled={state==='submitting'} type="submit" style={primaryBtn}>
            {state==='submitting' ? (<span style={{ width: 18, height: 18, border: '2px solid var(--accent)', borderRightColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />) : (<Send size={22} />)}
          </button>
          <input ref={fileRef} onChange={onFileChange} type="file" name="file" style={{ display: 'none' }} />
          {captchaMode !== 'none' && <div id="cf-turnstile" data-sitekey={siteKey || ''} style={{ display: 'none' }}></div>}
          <input ref={hpRef} type="text" name="company" autoComplete="off" style={{ display: 'none' }} />
        </form>
        <div style={{ maxWidth: 900, margin: '6px auto 0', color: state==='done' ? 'var(--ok)' : state==='error' ? 'var(--error)' : 'transparent' }}>{state==='done' ? 'Готово! Скоро появится в канале.' : error || ''}</div>
      </div>
    </div>
  )
}
