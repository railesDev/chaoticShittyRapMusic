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
      callback: (token: string) => setCaptchaToken(token),
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (hpRef.current?.value) {
      setError('Ошибка валидации')
      return
    }
    let tokenToSend = captchaToken
    if (captchaMode !== 'none' && !tokenToSend && (window as any).turnstile) {
      try { tokenToSend = (window as any).turnstile.getResponse(widgetIdRef.current) || '' } catch {}
    }
    if (captchaMode !== 'none' && !tokenToSend) { setError('Подтвердите капчу'); return }
    setState('submitting')
    try {
      const fd = new FormData()
      fd.set(fields.get('text')!, text)
      fd.set(fields.get('token')!, tokenToSend || '')
      fd.set(fields.get('honeypot')!, hpRef.current?.value || '')
      // Add non-obfuscated fallbacks to improve compatibility
      if (tokenToSend) {
        fd.set('token', tokenToSend)
        fd.set('cf-turnstile-response', tokenToSend)
      }
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
      if (!res.ok) throw new Error(await res.text())
      setState('done')
    } catch (e: any) {
      setError(e?.message || 'Ошибка отправки')
      setState('error')
    }
  }

  return (
    <div style={{ maxWidth: 680, margin: '32px auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginBottom: 8 }}>Анонимная отправка</h1>
      <p style={{ color: '#555', marginTop: 0 }}>Текст + опциональное вложение (картинка, аудио, видео или файл). Включена автоматическая модерация на сервере.</p>
      <form onSubmit={handleSubmit}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Текст сообщения"
          required
          rows={6}
          style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #ccc' }}
        />
        <div style={{ height: 12 }} />
        <input ref={fileRef} type="file" name="file" />
        <input ref={hpRef} type="text" name="company" autoComplete="off" style={{ display: 'none' }} />
        <div style={{ height: 12 }} />
        {captchaMode !== 'none' && (
          <div id="cf-turnstile" data-sitekey={siteKey || ''}></div>
        )}
        <div style={{ height: 12 }} />
        <button disabled={state==='submitting'} type="submit" style={{ padding: '10px 16px', borderRadius: 8, border: 0, background: '#0a84ff', color: '#fff', cursor: 'pointer' }}>
          {state === 'submitting' ? 'Отправка…' : 'Отправить'}
        </button>
        {state === 'done' && <span style={{ marginLeft: 12, color: 'green' }}>Отправлено! Проверим и запостим.</span>}
        {error && <div style={{ marginTop: 8, color: 'crimson' }}>{error}</div>}
      </form>
      <div style={{ marginTop: 24, fontSize: 13, color: '#666' }}>
        <div>Антиспам: капча, хонипот, ограничение частоты, валидация типов/размеров.</div>
      </div>
    </div>
  )
}
