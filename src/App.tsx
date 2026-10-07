import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { HomeGuide } from './home/HomeGuide'
import { Navigation } from './navigation/Navigation'
import { askForMotionOnFirstTap, watchFalls } from './safety/fall'
import { FallAlert } from './safety/FallAlert'
import { FamilySettings } from './safety/FamilySettings'
import { applyTheme, currentTheme, type Theme } from './theme'
import { VoiceButton } from './navigation/VoiceButton'
import type { TripRequest } from './navigation/voice'
import { Viewport, type Frame, type Source } from './Viewport'
import { classColor, coverage, HAZARD_COLOR, SURFACE_COLOR } from './yolo/draw'
import { YoloModel } from './yolo/model'
import type { Engine, EnginePreference, ModelInfo } from './yolo/types'

const MODELS_URL = `${import.meta.env.BASE_URL}models/`
/** ADE20K classes that mean a change in floor level. */
const STAIR_NAMES = ['stairs', 'stairway', 'step', 'escalator']
/** How long the simulated shake plays before the fall alert opens. */
const SHAKE_DEMO_MS = 700
const NONE: readonly number[] = []
const NO_NAMES: string[] = []
const ADD_MODEL_HINT = 'Run "uv run scripts/export_model.py yolo26n" to add one.'

type ModelStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; fraction: number }
  | { kind: 'ready'; engine: Engine; fallbackReason?: string }
  | { kind: 'error'; message: string }

const ENGINES: { value: EnginePreference; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'webgpu', label: 'GPU' },
  { value: 'wasm', label: 'CPU' },
]

const formatMB = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`
const formatMs = (ms: number) => (ms < 10 ? ms.toFixed(1) : String(Math.round(ms)))

function cameraErrorMessage(err: unknown): string {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Camera access needs a secure page. Open this app over HTTPS or on localhost.'
  }
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError') {
    return 'Camera access is blocked. Allow it in your browser’s site settings, then select Start camera again.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found. Connect one, or open an image instead.'
  }
  if (name === 'NotReadableError') {
    return 'Another app is using the camera. Close it, then select Start camera again.'
  }
  return `The camera couldn’t start: ${err instanceof Error ? err.message : String(err)}`
}

function engineSummary(status: ModelStatus): string {
  if (status.kind === 'ready' && status.engine === 'webgpu') return 'Running on your GPU with WebGPU.'
  if (status.kind === 'ready') {
    return status.fallbackReason
      ? `${status.fallbackReason} Running on your CPU instead.`
      : 'Running on your CPU with WebAssembly.'
  }
  if (status.kind === 'loading') return 'Starting the models…'
  return ''
}

function tally(frame: Frame | null, names: string[]) {
  const counts = new Map<number, number>()
  for (const d of frame?.objects?.detections ?? []) counts.set(d.classId, (counts.get(d.classId) ?? 0) + 1)
  return [...counts]
    .map(([classId, count]) => ({ classId, count, name: names[classId] ?? `class ${classId}` }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Loads `info` into `instance` whenever either (or the engine) changes, and reports progress. */
function useLoadedModel(instance: YoloModel | null, info: ModelInfo | null, engine: EnginePreference): ModelStatus {
  const key = info ? `${info.id}:${engine}` : null
  // Tagged with what was loaded, so a new selection reads as loading until it reports.
  const [loaded, setLoaded] = useState<{ key: string; status: ModelStatus } | null>(null)

  useEffect(() => {
    if (!instance || !info || !key) return
    let stale = false
    const report = (status: ModelStatus) => !stale && setLoaded({ key, status })
    instance
      .load(info, MODELS_URL + info.file, engine, (fraction) => report({ kind: 'loading', fraction }))
      .then((r) => report({ kind: 'ready', ...r }))
      .catch((err: Error) => report({ kind: 'error', message: err.message }))
    return () => {
      stale = true
    }
  }, [instance, info, engine, key])

  if (!key) return { kind: 'idle' }
  return loaded?.key === key ? loaded.status : { kind: 'loading', fraction: 0 }
}

export default function App() {
  const [runners, setRunners] = useState<{ objects: YoloModel; surfaces: YoloModel; hazards: YoloModel } | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelId, setModelId] = useState<string | null>(null)
  const [engine, setEngine] = useState<EnginePreference>('auto')
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [wallsOn, setWallsOn] = useState(true)
  const [stairsOn, setStairsOn] = useState(true)
  const [hazardsOn, setHazardsOn] = useState(true)
  const [source, setSource] = useState<Source | null>(null)
  const [conf, setConf] = useState(0.15)
  const [frame, setFrame] = useState<Frame | null>(null)
  const [fps, setFps] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [trip, setTrip] = useState<TripRequest | null>(null)
  const [fallen, setFallen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(currentTheme)

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setTheme(next)
  }

  useEffect(() => {
    if (!settingsOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSettingsOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])
  const [shaking, setShaking] = useState(false)

  /** Laptops have no motion sensor, so this acts out a shake and then raises the alert. */
  function simulateShake() {
    setShaking(true)
    setTimeout(() => {
      setShaking(false)
      setFallen(true)
    }, SHAKE_DEMO_MS)
  }
  const closeFallAlert = useCallback(() => setFallen(false), [])

  // A fall opens the SOS alert; while it's open, further jolts are ignored.
  useEffect(() => {
    const stopAsking = askForMotionOnFirstTap()
    const stopWatching = watchFalls(() => setFallen(true))
    return () => {
      stopAsking()
      stopWatching()
    }
  }, [])
  // Set when the camera was turned on for a trip, so closing the trip turns it off again.
  const cameraForGuide = useRef(false)
  const [home, setHome] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const lastFrameAt = useRef<number | null>(null)

  const detectModels = models.filter((m) => m.task === 'detect' && m.role !== 'hazard')
  const hazardModel = models.find((m) => m.task === 'detect' && m.role === 'hazard') ?? null
  const hazardNames = hazardModel?.names ?? NO_NAMES
  const model = detectModels.find((m) => m.id === modelId) ?? null
  const wallModel = models.find((m) => m.task === 'semantic' && m.names.includes('wall')) ?? null
  const wallClasses = useMemo(() => (wallModel ? [wallModel.names.indexOf('wall')] : []), [wallModel])
  const stairClasses = useMemo(
    () => (wallModel ? STAIR_NAMES.map((n) => wallModel.names.indexOf(n)).filter((i) => i >= 0) : []),
    [wallModel],
  )
  const names = model?.names ?? []

  useEffect(() => {
    // Each model runs in its own worker, so they run in parallel.
    // Workers are external resources, so they're created (and terminated) here rather than during render.
    const next = { objects: new YoloModel(), surfaces: new YoloModel(), hazards: new YoloModel() }
    // oxlint-disable-next-line react/set-state-in-effect
    setRunners(next)
    return () => {
      next.objects.dispose()
      next.surfaces.dispose()
      next.hazards.dispose()
    }
  }, [])

  useEffect(() => {
    fetch(`${MODELS_URL}manifest.json`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<{ models: ModelInfo[] }>
      })
      .then(({ models }) => {
        setModels(models)
        setModelId(models.find((m) => m.task === 'detect')?.id ?? null)
        if (!models.some((m) => m.task === 'detect')) setManifestError(`No object models are installed. ${ADD_MODEL_HINT}`)
      })
      .catch(() => setManifestError(`The model list is missing. ${ADD_MODEL_HINT}`))
  }, [])

  const objectStatus = useLoadedModel(runners?.objects ?? null, model, engine)
  // The wall model stays loaded while highlighting is off, so turning it back on is instant.
  const wallStatus = useLoadedModel(runners?.surfaces ?? null, wallModel, engine)
  // Loaded only while wanted: at 50 MB it's the largest model.
  const showHazards = hazardsOn && hazardModel !== null
  const hazardStatus = useLoadedModel(runners?.hazards ?? null, showHazards ? hazardModel : null, engine)
  const status: ModelStatus = manifestError ? { kind: 'error', message: manifestError } : objectStatus

  // Release the camera or the image's object URL when the source changes.
  useEffect(() => {
    if (source?.kind === 'camera') return () => source.stream.getTracks().forEach((t) => t.stop())
    if (source?.kind === 'image' && source.url.startsWith('blob:')) return () => URL.revokeObjectURL(source.url)
  }, [source])

  const showSource = (next: Source | null) => {
    setSource(next)
    setFrame(null)
    setFps(null)
    setNotice(null)
    lastFrameAt.current = null
  }

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      showSource({ kind: 'camera', stream })
    } catch (err) {
      setNotice(cameraErrorMessage(err))
    }
  }

  /** Outdoor and indoor guidance both need the camera; turn it on unless it already is. */
  function cameraForGuidance() {
    if (source?.kind === 'camera') return
    cameraForGuide.current = true
    startCamera()
  }

  function startTrip(next: TripRequest) {
    setTrip(next)
    cameraForGuidance()
  }

  function startHome() {
    setHome(true)
    cameraForGuidance()
  }

  // Stable, because Navigation listens for Escape with it.
  const closeGuide = useCallback(() => {
    setTrip(null)
    setHome(false)
    if (!cameraForGuide.current) return
    cameraForGuide.current = false
    setSource(null)
    setFrame(null)
    setFps(null)
    lastFrameAt.current = null
  }, [])

  const openImage = (file: File) => showSource({ kind: 'image', url: URL.createObjectURL(file), name: file.name })

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) openImage(file)
    e.target.value = ''
  }

  const onFrame = useCallback((next: Frame, live: boolean) => {
    setFrame(next)
    if (!live) return
    const now = performance.now()
    if (lastFrameAt.current !== null) {
      const instant = 1000 / (now - lastFrameAt.current)
      setFps((prev) => (prev === null ? instant : prev * 0.85 + instant * 0.15))
    }
    lastFrameAt.current = now
  }, [])

  const live = source?.kind === 'camera'
  const showWalls = wallsOn && wallModel !== null
  const showStairs = stairsOn && stairClasses.length > 0
  // One surface model finds both walls and stairs, so it runs while either is wanted.
  const runSurfaces = showWalls || showStairs
  const counts = tally(frame, names)
  const wallShare = showWalls && frame?.surfaces ? coverage(frame.surfaces, wallClasses) : null
  const loading =
    status.kind === 'loading' && model
      ? { label: model.label, fraction: status.fraction }
      : runSurfaces && wallStatus.kind === 'loading'
        ? { label: 'the wall and stairs model', fraction: wallStatus.fraction }
        : showHazards && hazardStatus.kind === 'loading'
          ? { label: 'the pothole and ladder model', fraction: hazardStatus.fraction }
          : null
  const errors = [status, runSurfaces ? wallStatus : null, showHazards ? hazardStatus : null].flatMap((s) => (s?.kind === 'error' ? [s.message] : []))
  const modelTimes = [
    frame?.objects && `objects ${formatMs(frame.objects.timings.inference)} ms`,
    frame?.surfaces && `walls ${formatMs(frame.surfaces.timings.inference)} ms`,
  ].filter(Boolean)

  const viewport = (
    <Viewport
      objects={status.kind === 'ready' ? runners!.objects : null}
      surfaces={runSurfaces && wallStatus.kind === 'ready' ? runners!.surfaces : null}
      hazards={showHazards && hazardStatus.kind === 'ready' ? runners!.hazards : null}
      hazardNames={hazardNames}
      source={source}
      conf={conf}
      names={names}
      surfaceClasses={showWalls ? wallClasses : NONE}
      hazardClasses={showStairs ? stairClasses : NONE}
      onFrame={onFrame}
      onError={setNotice}
      onDropImage={openImage}
    >
      {/* During a trip the empty state only needs a way to retry the camera. */}
      {!source && trip && (
        <div className="empty">
          <p className="empty-title">{notice ?? 'Starting the camera…'}</p>
          <div className="actions">
            <button type="button" className="button primary" onClick={startCamera}>
              Start camera
            </button>
          </div>
        </div>
      )}
      {source?.kind === 'image' && (
        <div className="viewport-actions">
          <button type="button" className="button upload-photo photo-action" onClick={() => fileInput.current?.click()}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                d="M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            New photo
          </button>
          <button type="button" className="button photo-action" aria-label="Close the photo" onClick={() => showSource(null)}>
            ×
          </button>
        </div>
      )}
      {!source && !trip && (
        <div className="empty">
          <p className="empty-title">Point a camera at a room, or open a photo.</p>
          {/* Phones hide the settings panel, so camera errors show here too. */}
          <p className="empty-hint" data-error={notice ? '' : undefined}>
            {notice ?? 'You can also drop an image anywhere in this frame.'}
          </p>
          <div className="actions">
            <button type="button" className="button primary start-camera" onClick={startCamera}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  d="M4 8h3l2-3h6l2 3h3v11H4z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              Start camera
            </button>
            {/* Phones hide the settings panel, so its "Open image" needs a twin here. */}
            <button type="button" className="button on-dark upload-photo" onClick={() => fileInput.current?.click()}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  d="M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Upload a photo
            </button>
          </div>
        </div>
      )}
      {loading && (
        <div className="status" role="status">
          <span>
            {loading.fraction < 1
              ? `Downloading ${loading.label}, ${Math.round(loading.fraction * 100)}%`
              : `Preparing ${loading.label}…`}
          </span>
          <span className="progress" style={{ '--fraction': loading.fraction } as CSSProperties} />
        </div>
      )}
      {errors.length > 0 && (
        <div className="status error" role="alert">
          {errors.join(' ')}
        </div>
      )}
    </Viewport>
  )

  return (
    <div className="app" data-shaking={shaking || undefined}>
      <header className="masthead">
        <h1 className="wordmark">yooolo</h1>
        <p className="tagline">Objects and walls, found by Ultralytics YOLO running entirely in your browser.</p>
      </header>

      <main className="workspace">
        <section className="stage" aria-label="Detection view">
          {!trip && !home && viewport}

          <dl className="readout">
            <div className="metric">
              <dt>{live ? 'frames per second' : 'ms per image'}</dt>
              <dd>{live ? (fps === null ? '–' : Math.round(fps)) : frame ? formatMs(frame.elapsed) : '–'}</dd>
            </div>
            <div className="metric">
              <dt>{frame?.objects?.detections.length === 1 ? 'object' : 'objects'}</dt>
              <dd>{frame?.objects ? frame.objects.detections.length : '–'}</dd>
            </div>
            {showWalls && (
              <div className="metric">
                <dt>of the view is wall</dt>
                <dd>{wallShare === null ? '–' : `${Math.round(wallShare * 100)}%`}</dd>
              </div>
            )}
          </dl>

          {(counts.length > 0 || modelTimes.length > 0) && (
            <div className="details">
              {counts.length > 0 && (
                <ul className="tally" aria-label="Objects found">
                  {counts.map((c) => (
                    <li key={c.classId}>
                      <span className="swatch" style={{ background: classColor(c.classId) }} />
                      {c.name}
                      <span className="count">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              {modelTimes.length > 0 && <p className="timing">Model time: {modelTimes.join(', ')}.</p>}
            </div>
          )}
        </section>

        <aside className="panel" aria-label="Settings">
          <div className="field">
            <h2 className="field-label">Source</h2>
            <div className="actions">
              {live ? (
                <button type="button" className="button" onClick={() => showSource(null)}>
                  Stop camera
                </button>
              ) : (
                <button type="button" className="button primary" onClick={startCamera}>
                  Start camera
                </button>
              )}
              <button type="button" className="button" onClick={() => fileInput.current?.click()}>
                Open image
              </button>
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={onFileChange} />
            </div>
            {notice && (
              <p className="notice" role="alert">
                {notice}
              </p>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="model">
              Object model
            </label>
            <select
              id="model"
              value={modelId ?? ''}
              disabled={!detectModels.length}
              onChange={(e) => setModelId(e.target.value)}
            >
              {detectModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({formatMB(m.bytes)})
                </option>
              ))}
              <option disabled>YOLO27 (not released yet)</option>
            </select>
          </div>

          <p className="privacy">Everything runs on this device. Video and images are never uploaded.</p>
        </aside>
      </main>

      <div className="header-tools">
        <button
          type="button"
          className="theme-button"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
              <path
                d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          )}
          <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
        <button
          type="button"
          className="settings-button"
          aria-label="Parental settings"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="settings-button-label">Parental settings</span>
        </button>
      </div>

      {settingsOpen && (
        <div className="settings-backdrop" onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
          <aside className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="settings-head">
              <h2 id="settings-title" className="settings-title">
                Parental settings
              </h2>
              <button type="button" className="voice-close" aria-label="Close" onClick={() => setSettingsOpen(false)}>
                ×
              </button>
            </div>
            <div className="field">
              <h2 className="field-label">Hazards</h2>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showWalls}
                  disabled={!wallModel}
                  onChange={(e) => setWallsOn(e.target.checked)}
                />
                <span className="swatch" style={{ background: SURFACE_COLOR }} />
                Highlight walls
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showStairs}
                  disabled={!stairClasses.length}
                  onChange={(e) => setStairsOn(e.target.checked)}
                />
                <span className="swatch" style={{ background: HAZARD_COLOR }} />
                Highlight stairs
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showHazards}
                  disabled={!hazardModel}
                  onChange={(e) => setHazardsOn(e.target.checked)}
                />
                <span className="swatch" style={{ background: HAZARD_COLOR }} />
                Detect ladders
              </label>
              <p className="hint">
                {wallModel
                  ? `Uses ${wallModel.label}, ${formatMB(wallModel.bytes)}${hazardModel ? `, and ${hazardModel.label}, ${formatMB(hazardModel.bytes)}` : ''}.`
                  : 'No wall model is installed. Run "uv run scripts/export_model.py yolo26n-sem-ade20k" to add one.'}
              </p>
            </div>

            {/* Laptops only: phones keep the automatic choice. */}
            <fieldset className="field settings-engine">
              <legend className="field-label">Runs on</legend>
              <div className="segmented">
                {ENGINES.map((e) => (
                  <label key={e.value}>
                    <input
                      type="radio"
                      name="engine"
                      value={e.value}
                      checked={engine === e.value}
                      onChange={() => setEngine(e.value)}
                    />
                    <span>{e.label}</span>
                  </label>
                ))}
              </div>
              <p className="hint">{engineSummary(status)}</p>
            </fieldset>

            <div className="field">
              <div className="field-row">
                <label className="field-label" htmlFor="conf">
                  Minimum object confidence
                </label>
                <output htmlFor="conf">{Math.round(conf * 100)}%</output>
              </div>
              <input
                id="conf"
                type="range"
                min={0.05}
                max={0.95}
                step={0.05}
                value={conf}
                onChange={(e) => setConf(Number(e.target.value))}
              />
            </div>

            <FamilySettings />

            {/* Laptops only: phones test the alert with a real fall. */}
            <div className="field settings-safety">
              <h2 className="field-label">Safety</h2>
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setSettingsOpen(false)
                    setFallen(true)
                  }}
                >
                  Test fall alert
                </button>
              </div>
              <p className="hint">On a phone, a fall or about two seconds of hard shaking opens an SOS alert for your parents and an ambulance. A quick shake doesn't.</p>
            </div>
            <button type="button" className="button settings-done" onClick={() => setSettingsOpen(false)}>
              Done
            </button>
          </aside>
        </div>
      )}

      {trip ? (
        <Navigation
          trip={trip}
          onClose={closeGuide}
          camera={viewport}
          detections={frame?.objects ?? null}
          names={names}
          surfaces={frame?.surfaces ?? null}
          stairClasses={showStairs ? stairClasses : NONE}
          hazardBoxes={frame?.hazards ?? null}
          hazardNames={hazardNames}
        />
      ) : home ? (
        <HomeGuide
          onClose={closeGuide}
          camera={viewport}
          objects={frame?.objects ?? null}
          surfaces={frame?.surfaces ?? null}
          objectNames={names}
          surfaceNames={wallModel?.names ?? NO_NAMES}
          stairClasses={showStairs ? stairClasses : NONE}
        />
      ) : (
        // Phones split the bottom of the screen between these two; laptops float them in a corner.
        <div className="dock">
          <button
            type="button"
            className="shake-fab"
            aria-label="Simulate a fall"
            title="Simulate a fall"
            disabled={shaking || fallen}
            onClick={simulateShake}
          >
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
              <rect x="8" y="3" width="8" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M4 8l-2 4 2 4M20 8l2 4-2 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="home-fab" aria-label="Find a room at home" onClick={startHome}>
            <svg className="voice-icon" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
              <path d="M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="voice-label" aria-hidden="true">
              Find a room at home
            </span>
          </button>
          <VoiceButton onTrip={startTrip} />
        </div>
      )}

      {fallen && <FallAlert onClose={closeFallAlert} />}
    </div>
  )
}
