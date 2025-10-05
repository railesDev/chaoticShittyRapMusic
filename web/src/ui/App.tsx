import React, { useCallback, useMemo, useRef, useState } from 'react'

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
  const container: React.CSSProperties = { maxWidth: 800, margin: '48px auto', padding: 24 }
  const title: React.CSSProperties = { fontSize: 44, fontWeight: 500, margin: '0 0 8px', letterSpacing: -0.5 }
  const subtitle: React.CSSProperties = { color: 'var(--muted)', margin: 0, fontSize: 18, fontWeight: 500 }
  const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 20, marginTop: 24 }
  const label: React.CSSProperties = { color: 'var(--muted)', marginBottom: 8, fontWeight: 500 }
  const textareaStyle: React.CSSProperties = { width: '100%', padding: 16, borderRadius: 12, border: '1px solid var(--border)', background: '#0f0f14', color: 'var(--text)', outline: 'none', fontSize: 16, resize: 'none' }
  const row: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }
  const primaryBtn: React.CSSProperties = { padding: '12px 18px', borderRadius: 999, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#0b0b0f', fontWeight: 500, letterSpacing: 0.2, cursor: 'pointer', boxShadow: '0 8px 28px rgba(113,195,203,0.35)', display: 'inline-flex', alignItems: 'center', gap: 8 }
  const ghostBtn: React.CSSProperties = { padding: '10px 14px', borderRadius: 999, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontWeight: 500, cursor: 'pointer' }
  const chip: React.CSSProperties = { padding: '6px 10px', borderRadius: 999, background: '#BBE3E6', color: '#0b0b0f', fontWeight: 500, display: 'inline-block' }

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewKind, setPreviewKind] = useState<'image'|'audio'|'video'|'file'|null>(null)
  const [replyInput, setReplyInput] = useState('')
  const [replyPreview, setReplyPreview] = useState<string>('')
  const [replyOpen, setReplyOpen] = useState(true)

  const onPickFile = useCallback(() => fileRef.current?.click(), [])
  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) { setPreviewUrl(null); setPreviewKind(null); return }
    const url = URL.createObjectURL(f)
    setPreviewUrl(url)
    if (f.type.startsWith('image/')) setPreviewKind('image')
    else if (f.type.startsWith('audio/')) setPreviewKind('audio')
    else if (f.type.startsWith('video/')) setPreviewKind('video')
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
      <div>
        <div style={chip}>CU Pulse</div>
        <h1 style={title}>Отправить сообщение</h1>
        <p style={subtitle}>Поддерживаются любые вложения. Работает модерация.</p>
      </div>

      <div style={card}>
        <form onSubmit={handleSubmit}>
          <div style={label}>Ответить на сообщение (cu-XXX)</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={replyInput} onChange={e=>setReplyInput(e.target.value)} placeholder="cu-123" style={{ flex: '0 0 220px', padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: '#0f0f14', color: 'var(--text)' }} />
            {!!replyPreview && <button type="button" onClick={()=>setReplyOpen(v=>!v)} style={{ ...ghostBtn, padding: '8px 12px' }}>{replyOpen ? 'Свернуть цитату' : 'Показать цитату'}</button>}
            {replyInput && <button type="button" onClick={()=>{setReplyInput(''); setReplyPreview('')}} style={{ ...ghostBtn, borderColor: 'var(--border)', color: 'var(--muted)', padding: '8px 12px' }}>Очистить</button>}
          </div>
          {replyInput && (
            <div style={{ marginTop: 10, borderLeft: '3px solid var(--accent)', paddingLeft: 12 }}>
              <div style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>
                {replyPreview ? replyPreview.slice(0,200) : 'Сообщение не найдено'}
              </div>
            </div>
          )}
          <div style={label}>Сообщение</div>
          <textarea value={text} onChange={(e)=>setText(e.target.value)} placeholder="Напишите, что важно…" rows={8} style={textareaStyle} />

          <div style={{ height: 10 }} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <button type="button" onClick={onPickFile} title="Вложение" style={{...ghostBtn, padding: '10px', borderRadius: 12}}>📎</button>
            <textarea value={text} onChange={(e)=>{setText(e.target.value); const t=e.target; t.style.height='auto'; t.style.height=Math.min(160, t.scrollHeight)+"px"}} placeholder="Напишите сообщение…" rows={3} style={{...textareaStyle, flex: 1, height: 56}} />
            <button disabled={state==='submitting'} type="submit" style={primaryBtn}>
              {state==='submitting' && <span style={{ width: 14, height: 14, border: '2px solid #0b0b0f', borderRightColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />}
              {state === 'submitting' ? 'Отправка…' : state === 'done' ? 'Отправлено' : state === 'error' ? 'Повторить?' : 'Отправить'}
            </button>
          </div>
          <input ref={fileRef} onChange={onFileChange} type="file" name="file" style={{ display: 'none' }} />

          {previewUrl && (
            <div style={{ marginTop: 12 }}>
              {previewKind === 'image' && <img src={previewUrl} alt="preview" style={{ maxWidth: '100%', borderRadius: 12, border: '1px solid var(--border)' }} />}
              {previewKind === 'audio' && <audio controls src={previewUrl} style={{ width: '100%' }} />}
              {previewKind === 'video' && <video controls src={previewUrl} style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border)' }} />}
              {previewKind === 'file' && <div style={{ color: 'var(--muted)' }}>Файл готов к отправке</div>}
            </div>
          )}

          <div style={{ height: 16 }} />
          {captchaMode !== 'none' && <div id="cf-turnstile" data-sitekey={siteKey || ''} style={{ display: 'none' }}></div>}

          <div style={{ height: 12 }} />
          <div style={row}>
            {state === 'done' && <span style={{ color: 'var(--ok)', fontWeight: 500 }}>Готово! Скоро появится в канале.</span>}
            {error && <span style={{ color: 'var(--error)' }}>{error}</span>}
          </div>

          <input ref={hpRef} type="text" name="company" autoComplete="off" style={{ display: 'none' }} />
        </form>
      </div>
    </div>
  )
}
