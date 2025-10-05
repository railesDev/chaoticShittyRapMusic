import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Paperclip, Send, Reply, Trash2, Pause, Play, Check } from 'lucide-react'

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
  const [rateLimitSec, setRateLimitSec] = useState<number>(10)
  const [fields] = useState(buildFields)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const hpRef = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const [padTop, setPadTop] = useState(10)
  const [captchaMode, setCaptchaMode] = useState<'turnstile' | 'hcaptcha' | 'none'>('turnstile')
  const widgetIdRef = useRef<any>(null)
  // Captcha token lifecycle
  const tokenVersionRef = useRef(0)
  const lastUsedTokenVersionRef = useRef(-1)
  const waitResolveRef = useRef<((t: string) => void) | null>(null)
  const waitTimerRef = useRef<number | null>(null)
  // UI gating: captcha refresh + cooldown
  const [isCaptchaRefreshing, setIsCaptchaRefreshing] = useState<boolean>(true)
  const [isCooldown, setIsCooldown] = useState<boolean>(false)
  const [statusTip, setStatusTip] = useState<string>('')
  const refreshRetryTimerRef = useRef<number | null>(null)
  const widgetRenderedRef = useRef<boolean>(false)
  const refreshingInFlightRef = useRef<boolean>(false)

  const triggerCaptchaRefresh = useCallback((delay = 0) => {
    if (captchaMode === 'none') {
      setIsCaptchaRefreshing(false)
      setStatusTip('')
      return
    }
    const run = () => {
      try {
        if (refreshingInFlightRef.current) return
        const ts: any = (window as any).turnstile
        if (!ts || !widgetRenderedRef.current) return
        refreshingInFlightRef.current = true
        setIsCaptchaRefreshing(true)
        setStatusTip('Обновляю капчу')
        try { ts.reset(widgetIdRef.current) } catch {}
      } catch {}
    }
    if (delay > 0) {
      window.setTimeout(run, delay)
    } else {
      run()
    }
  }, [captchaMode])

  const reset = useCallback(() => {
    setState('idle'); setError(null); setCaptchaToken(''); setText('')
    if (fileRef.current) fileRef.current.value = ''
    if (window.turnstile) {
      try { window.turnstile.reset(widgetIdRef.current) } catch {}
    }
  }, [])

  const onLoadTurnstile = useCallback(() => {
    if (!siteKey || !window.turnstile) return
    if (widgetRenderedRef.current) return
    const id = window.turnstile.render('#cf-turnstile', {
      sitekey: siteKey,
      callback: (token: string) => {
        setCaptchaToken(token)
        tokenVersionRef.current += 1
        setIsCaptchaRefreshing(false)
        refreshingInFlightRef.current = false
        if (statusTip) setStatusTip('')
        if (waitResolveRef.current) {
          waitResolveRef.current(token)
          waitResolveRef.current = null
          if (waitTimerRef.current) {
            window.clearTimeout(waitTimerRef.current)
            waitTimerRef.current = null
          }
        }
      },
      'error-callback': () => {
        setCaptchaToken('')
        refreshingInFlightRef.current = false
        // Retry after a short delay
        if (refreshRetryTimerRef.current) {
          window.clearTimeout(refreshRetryTimerRef.current)
          refreshRetryTimerRef.current = null
        }
        refreshRetryTimerRef.current = window.setTimeout(() => triggerCaptchaRefresh(0), 1500)
      }
    })
    widgetIdRef.current = id
    widgetRenderedRef.current = true
    // Immediately trigger a token fetch after render
    triggerCaptchaRefresh(0)
  }, [siteKey, triggerCaptchaRefresh])

  React.useEffect(() => {
    // fetch runtime config for captcha site key
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/config`)
        if (res.ok) {
          const j = await res.json()
          if (j?.turnstile_site_key) setSiteKey(j.turnstile_site_key)
          if (j?.captcha) {
            setCaptchaMode(j.captcha)
            if (j.captcha === 'none') {
              setIsCaptchaRefreshing(false)
              setStatusTip('')
            }
          }
          if (Number.isFinite(j?.rate_limit_seconds)) setRateLimitSec(parseInt(j.rate_limit_seconds, 10))
        }
      } catch {}
    })()
    // show status while captcha is being prepared (on first load)
    if (captchaMode !== 'none') {
      setIsCaptchaRefreshing(true)
      setStatusTip('Обновляю капчу')
    }
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

  // Adjust layout for visual viewport (iOS keyboard etc.)
  React.useEffect(() => {
    const vv = (window as any).visualViewport
    if (!vv) return
    const update = () => {
      const bottomInset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
      document.documentElement.style.setProperty('--vv-top', `${vv.offsetTop || 0}px`)
      document.documentElement.style.setProperty('--vv-bottom', `${bottomInset}px`)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [])


  // Prevent page scroll (especially on iOS).
  // Allow vertical scroll inside composer editable or the content box between header and composer.
  React.useEffect(() => {
    const onTouchMove = (e: TouchEvent) => {
      const editable = (taRef.current as unknown as HTMLElement | null)
      const scrollBox = (contentRef.current as unknown as HTMLElement | null)
      const t = e.target as HTMLElement | null
      if (editable && t && editable.contains(t)) {
        const canScroll = editable.scrollHeight > editable.clientHeight
        if (!canScroll) e.preventDefault()
        return
      }
      if (scrollBox && t && scrollBox.contains(t)) {
        return
      }
      e.preventDefault()
    }
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => window.removeEventListener('touchmove', onTouchMove)
  }, [])


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    // Require either text or attachment
    const hasFile = !!(fileRef.current?.files && fileRef.current.files[0])
    if (!hasFile && !text.trim()) {
      setErrorTip('Добавь текст или вложение')
      setTimeout(() => setErrorTip(''), 2000)
      return
    }
    if (hpRef.current?.value) {
      setError('Ошибка валидации')
      return
    }
    let tokenToSend = ''
    try {
      tokenToSend = await requireCaptchaToken()
    } catch (err: any) {
      setError(err?.message || 'Подтвердите капчу')
      setErrorTip('Подтвердите капчу')
      setTimeout(() => setErrorTip(''), 2000)
      return
    }
    setState('submitting')
    setSendState('sending')
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
        if (res.status === 429) {
          setErrorTip('Слишком часто, попробуй позже')
          setTimeout(() => setErrorTip(''), 2000)
        }
        const txt = await res.text().catch(() => '')
        let j: any = null
        try { j = txt ? JSON.parse(txt) : null } catch {}
        if (j?.error === 'captcha_failed') {
          // mark old token as used and request a fresh token next time
          lastUsedTokenVersionRef.current = tokenVersionRef.current
          throw new Error('Капча истекла, попробуйте ещё раз')
        }
        if (j?.error === 'reply_not_found') {
          setErrorTip('Сообщение для ответа не найдено')
          setTimeout(() => setErrorTip(''), 2000)
        }
        if (!j) {
          setErrorTip('Ошибка, попробуй позже')
          setTimeout(() => setErrorTip(''), 2000)
        }
        throw new Error(j ? JSON.stringify(j) : (txt || 'Ошибка отправки'))
      }
      // mark token as used to force refresh next submit
      lastUsedTokenVersionRef.current = tokenVersionRef.current
      // reset inputs on success
      setText('')
      setReplyInput('')
      setReplyPreview('')
      try {
        const el = taRef.current as unknown as HTMLDivElement | null
        if (el) el.innerText = ''
      } catch {}
      if (fileRef.current) fileRef.current.value = ''
      setPreviewUrl(null); setPreviewKind(null); setAudioMeta(null)
      setState('done')
      setSendState('success')
      // After the checkmark, start background captcha refresh and cooldown
      setTimeout(() => {
        setSendState('idle')
        // Start captcha refresh (if captcha is enabled)
        triggerCaptchaRefresh(0)
        // Start cooldown timer
        if (rateLimitSec > 0) {
          setIsCooldown(true)
          window.setTimeout(() => setIsCooldown(false), rateLimitSec * 1000)
        }
      }, 1500)
    } catch (e: any) {
      setError(e?.message || 'Ошибка отправки')
      setErrorTip('Попробуй позже')
      setTimeout(() => setErrorTip(''), 1800)
      setState('error')
      setSendState('idle')
    }
  }

  React.useEffect(() => {
    if (state === 'done' || state === 'error') {
      const t = setTimeout(() => setState('idle'), 10000)
      return () => clearTimeout(t)
    }
  }, [state])

  // Styles
  const container: React.CSSProperties = { maxWidth: 900, margin: '0 auto', padding: '0 16px', height: '100dvh', overflow: 'hidden', position: 'relative' }
  const HEADER_H = 56
  const FOOTER_SPACE = 180
  const headerWrap: React.CSSProperties = { position: 'fixed', top: 'var(--vv-top, 0px)', left: 0, right: 0, height: HEADER_H, zIndex: 20, background: 'var(--bg)', display: 'flex', alignItems: 'center' }
  const headerRow: React.CSSProperties = { maxWidth: 900, margin: '0 auto', padding: '0 16px', display: 'flex', alignItems: 'center', gap: 10 }
  const title: React.CSSProperties = { fontSize: 'clamp(32px, 6vw, 56px)', fontWeight: 600, margin: '8px 0 6px', letterSpacing: -0.5, lineHeight: 1.05 }
  const subtitle: React.CSSProperties = { color: 'var(--muted)', margin: 0, fontSize: 16, fontWeight: 500 }
  // Scrollable content area between sticky header and composer
  const contentWrap: React.CSSProperties = { position: 'fixed', top: `calc(var(--vv-top, 0px) + ${HEADER_H}px)`, left: 0, right: 0, bottom: 'calc(var(--composer-h, 180px) + var(--vv-bottom, 0px))', overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' as any, padding: '8px 16px' }
  const composerWrap: React.CSSProperties = { position: 'fixed', left: 0, right: 0, bottom: 'var(--vv-bottom, 0px)', zIndex: 30, background: 'var(--bg)', padding: '8px 12px calc(8px + env(safe-area-inset-bottom))' }
  const composerInner: React.CSSProperties = { maxWidth: 900, margin: '0 auto', display: 'flex', gap: 12, flexDirection: 'column', position: 'relative' }
  const label: React.CSSProperties = { color: 'var(--muted)', marginBottom: 8, fontWeight: 500, fontSize: 14 }
  const textareaStyle: React.CSSProperties = { width: '100%', padding: 14, borderRadius: 20, border: 'none', background: 'transparent', color: 'var(--text)', outline: 'none', fontSize: 16, resize: 'none' }
  const row: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }
  const chip: React.CSSProperties = { padding: '8px 14px', borderRadius: 999, background: '#BBE3E6', color: '#0b0b0f', fontWeight: 600, display: 'inline-block' }
  // Align items to the center so icons, placeholder and text stay on one level
  const composerBoxBase: React.CSSProperties = { display: 'flex', gap: 8, borderRadius: 28, border: '1px solid var(--border)', background: '#0f0f14', padding: '4px 10px', boxShadow: '0 0 0 1px rgba(255,255,255,0.04) inset', alignItems: 'center', minHeight: 48 }
  // Plain icon button, vertically centered without extra translate hacks
  const iconBtnPlain: React.CSSProperties = { width: 40, height: 40, border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
  const replyInputStyle: React.CSSProperties = { flex: '0 0 210px', padding: '8px 12px', borderRadius: 14, border: 'none', background: '#0f0f14', color: 'var(--text)', outline: 'none', boxShadow: '0 0 0 1px rgba(255,255,255,0.06) inset', fontSize: 14 }

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLDivElement | null>(null)
  const [previewKind, setPreviewKind] = useState<'image'|'audio'|'video'|'file'|null>(null)
  const [audioMeta, setAudioMeta] = useState<{name: string; duration: number} | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioTime, setAudioTime] = useState(0)
  const [replyInput, setReplyInput] = useState('')
  const [replyPreview, setReplyPreview] = useState<string>('')
  const [replyOpen, setReplyOpen] = useState(true)
  const [sendState, setSendState] = useState<'idle'|'sending'|'success'>('idle')
  const [errorTip, setErrorTip] = useState('')

  const onPickFile = useCallback(() => fileRef.current?.click(), [])
  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) { setPreviewUrl(null); setPreviewKind(null); setAudioMeta(null); return }
    if (f.type.startsWith('video/')) { alert('Видео не поддерживается'); if (fileRef.current) fileRef.current.value=''; return }
    const url = URL.createObjectURL(f)
    setPreviewUrl(url)
    if (f.type.startsWith('image/')) setPreviewKind('image')
    else if (f.type.startsWith('audio/')) {
      setPreviewKind('audio')
      setAudioMeta({ name: f.name.replace(/\.[^.]+$/, ''), duration: 0 })
    }
    else setPreviewKind('file')
  }, [])
  const clearFile = useCallback(() => {
    if (fileRef.current) fileRef.current.value = ''
    setPreviewUrl(null); setPreviewKind(null); setAudioMeta(null); setAudioPlaying(false); setAudioTime(0)
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

  // Always keep the content area scrolled to the bottom so blocks (reply/preview) hug the composer.
  React.useEffect(() => {
    const c = contentRef.current
    if (!c) return
    // Defer to next frame so layout has correct sizes
    const id = requestAnimationFrame(() => { c.scrollTop = c.scrollHeight })
    return () => cancelAnimationFrame(id)
  }, [replyInput, replyPreview, previewUrl, previewKind, audioMeta])

  // Keep content bottom equal to the real composer height
  React.useEffect(() => {
    const update = () => {
      const el = composerRef.current
      const h = el ? Math.ceil(el.getBoundingClientRect().height) : FOOTER_SPACE
      document.documentElement.style.setProperty('--composer-h', `${h}px`)
    }
    update()
    const vv: any = (window as any).visualViewport
    const ro: any = (window as any).ResizeObserver ? new (window as any).ResizeObserver(() => update()) : null
    if (ro && composerRef.current) ro.observe(composerRef.current)
    window.addEventListener('resize', update)
    vv?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      vv?.removeEventListener('resize', update)
      try { ro && composerRef.current && ro.unobserve(composerRef.current) } catch {}
    }
  }, [text, replyInput, previewUrl, previewKind, audioMeta, sendState])

  function formatTime(total: number) {
    if (!Number.isFinite(total) || total <= 0) return '00:00'
    const m = Math.floor(total / 60)
    const s = Math.floor(total % 60)
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  }

  function progressPct(current: number, total?: number) {
    if (!total || total <= 0) return 0
    return Math.min(100, Math.max(0, (current / total) * 100))
  }

  return (
    <div style={container}>
      <div style={headerWrap}>
        <div style={headerRow}>
          <div style={chip}>CU Pulse</div>
          <p style={subtitle}>Используй с умом</p>
        </div>
      </div>

      <div style={contentWrap} ref={contentRef}>
        <div style={{ maxWidth: 900, margin: '0 auto', minHeight: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 10 }}>
          <div>
            <div style={label}>Ответить на</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--muted)' }}>
              <Reply size={24} color={'var(--accent)'} />
              <input id="reply-input" value={replyInput} onChange={e=>setReplyInput(e.target.value)} placeholder="cu-XXX" style={replyInputStyle} />
            </div>
          </div>
          {replyInput && (
            <div style={{ borderLeft: '3px solid var(--accent)', paddingLeft: 14 }}>
              <div style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap', fontSize: 16, lineHeight: 1.4 }}>{replyPreview ? replyPreview.slice(0,200) : 'Сообщение не найдено'}</div>
            </div>
          )}
          {previewUrl && (
            <div>
              {previewKind === 'image' && (
                <div style={{ position: 'relative' }}>
                  <img src={previewUrl} alt="preview" style={{ width: '100%', maxHeight: 360, objectFit: 'cover', borderRadius: 20, border: '1px solid var(--border)' }} />
                  <button type="button" onClick={clearFile} title="Удалить" style={{ position: 'absolute', right: 10, bottom: 10, width: 40, height: 40, borderRadius: 12, background: 'rgba(0,0,0,0.55)', border: '1px solid var(--border)', color: 'var(--danger)', display:'inline-flex', alignItems:'center', justifyContent:'center' }}>
                    <Trash2 size={20} />
                  </button>
                </div>
              )}
              {previewKind === 'audio' && (
                <div style={{ position: 'relative', border: '1px solid var(--border)', background: '#0f0f14', borderRadius: 20, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button type="button" aria-label={audioPlaying ? 'Пауза' : 'Воспроизвести'} onClick={() => {
                      const a = audioRef.current
                      if (!a) return
                      if (audioPlaying) { a.pause(); setAudioPlaying(false) } else { a.play().catch(()=>{}); setAudioPlaying(true) }
                    }} style={{ width: 44, height: 44, borderRadius: 999, border: '1px solid var(--accent)', color: 'var(--accent)', background: 'transparent', display:'inline-flex', alignItems:'center', justifyContent:'center' }}>
                      {audioPlaying ? <Pause size={22}/> : <Play size={22}/>}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap: 8 }}>
                        <div style={{ color: 'var(--text)', fontWeight: 500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{audioMeta?.name || 'Аудио'}</div>
                        <div style={{ color: 'var(--muted)', flex: '0 0 auto' }}>{formatTime(audioMeta?.duration || 0)}</div>
                      </div>
                      <div style={{ position: 'relative', height: 4, marginTop: 10, background: 'rgba(255,255,255,0.08)', borderRadius: 999 }}>
                        <div style={{ position:'absolute', left: 0, top:0, bottom:0, width: `${progressPct(audioTime, audioMeta?.duration)}%`, background: 'var(--accent)', borderRadius: 999 }} />
                      </div>
                    </div>
                    <button type="button" onClick={clearFile} title="Удалить" style={{ width: 40, height: 40, borderRadius: 12, border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger)', display:'inline-flex', alignItems:'center', justifyContent:'center' }}>
                      <Trash2 size={20} />
                    </button>
                  </div>
                  <audio ref={audioRef} src={previewUrl} style={{ display:'none' }} onLoadedMetadata={(e) => {
                    const a = e.currentTarget
                    setAudioMeta(m => ({ name: m?.name || 'Аудио', duration: a.duration || 0 }))
                  }} onTimeUpdate={(e) => setAudioTime(e.currentTarget.currentTime)} onEnded={() => { setAudioPlaying(false); setAudioTime(0) }} />
                </div>
              )}
              {previewKind === 'file' && (
                <div style={{ position: 'relative', border: '1px solid var(--border)', background: '#0f0f14', borderRadius: 20, padding: 16, color: 'var(--muted)' }}>
                  Файл готов к отправке
                  <button type="button" onClick={clearFile} title="Удалить" style={{ position:'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', width: 40, height: 40, borderRadius: 12, border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger)', display:'inline-flex', alignItems:'center', justifyContent:'center' }}>
                    <Trash2 size={20} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={composerWrap} ref={composerRef}>
        <div style={{ maxWidth: 900, margin: '0 auto', position: 'relative' }}>
        <form onSubmit={handleSubmit} style={composerInner}>
          <div style={composerBoxBase}>
            <button type="button" onClick={onPickFile} title="Вложение" style={iconBtnPlain}>
              <Paperclip size={22} />
            </button>
            <div
              className="composer-editable"
              ref={taRef as any}
              contentEditable
              role="textbox"
              aria-multiline="true"
              data-placeholder="Поделись тем, что важно"
              onTouchMoveCapture={(e)=>{ e.stopPropagation() }}
              onInput={(e)=>{
                const v = (e.currentTarget as HTMLDivElement).innerText
                setText(v)
              }}
              style={{
                flex: 1,
                minHeight: 24,
                maxHeight: 140,
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
                lineHeight: '20px',
                padding: '10px 14px',
                outline: 'none',
                background: 'transparent',
                color: 'var(--text)',
                borderRadius: 28,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                touchAction: 'pan-y'
              }}
            />
            <button aria-label="Отправить" disabled={state==='submitting' || isCaptchaRefreshing || isCooldown} type="submit" style={iconBtnPlain}>
              {state==='submitting' ? (
                <span style={{ width: 16, height: 16, border: '2px solid var(--accent)', borderRightColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              ) : (isCaptchaRefreshing || isCooldown) ? (
                <span style={{ width: 16, height: 16, border: '2px solid var(--accent)', borderRightColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              ) : sendState==='success' ? (
                <Check size={22} />
              ) : (
                <Send size={22} />
              )}
            </button>
          </div>
          
          <input ref={fileRef} onChange={onFileChange} type="file" name="file" style={{ display: 'none' }} />
          {captchaMode !== 'none' && <div id="cf-turnstile" data-sitekey={siteKey || ''} style={{ display: 'none' }}></div>}
          <input ref={hpRef} type="text" name="company" autoComplete="off" style={{ display: 'none' }} />
          {/* Floating tips */}
          {errorTip && (
            <div style={{ position:'absolute', right: 14, bottom: 58, zIndex: 50, background: 'rgba(244,63,94,0.97)', color:'#fff', padding:'6px 10px', borderRadius: 8, fontSize: 12, boxShadow:'0 6px 16px rgba(0,0,0,0.35)' }}>{errorTip}</div>
          )}
          {statusTip && (
            <div style={{ position:'absolute', right: 14, bottom: 58, zIndex: 45, background: 'rgba(255,255,255,0.10)', color:'var(--muted)', padding:'6px 10px', borderRadius: 8, fontSize: 12, boxShadow:'0 6px 16px rgba(0,0,0,0.20)' }}>{statusTip}</div>
          )}
        </form>
      </div>
    </div>
  </div>
  )
}
