import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { Viewport, type Frame, type Source } from './Viewport'
import { classColor, coverage, SURFACE_COLOR } from './yolo/draw'
import { YoloModel } from './yolo/model'
import type { Engine, EnginePreference, ModelInfo } from './yolo/types'

const MODELS_URL = `${import.meta.env.BASE_URL}models/`
const SAMPLES: { label: string; source: Source }[] = [
  {
    label: 'Try a room photo',
    source: { kind: 'image', url: `${import.meta.env.BASE_URL}samples/room.jpg`, name: 'A living room with sofas and large windows' },
  },
  {
    label: 'Try a street photo',
    source: { kind: 'image', url: `${import.meta.env.BASE_URL}samples/bus.jpg`, name: 'A street with a bus and four people' },
  },
]
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
  const [runners, setRunners] = useState<{ objects: YoloModel; surfaces: YoloModel } | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelId, setModelId] = useState<string | null>(null)
  const [engine, setEngine] = useState<EnginePreference>('auto')
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [wallsOn, setWallsOn] = useState(true)
  const [source, setSource] = useState<Source | null>(null)
  const [conf, setConf] = useState(0.35)
  const [frame, setFrame] = useState<Frame | null>(null)
  const [fps, setFps] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const lastFrameAt = useRef<number | null>(null)

  const detectModels = models.filter((m) => m.task === 'detect')
  const model = detectModels.find((m) => m.id === modelId) ?? null
  const wallModel = models.find((m) => m.task === 'semantic' && m.names.includes('wall')) ?? null
  const wallClasses = useMemo(() => (wallModel ? [wallModel.names.indexOf('wall')] : []), [wallModel])
  const names = model?.names ?? []

  useEffect(() => {
    // Each model runs in its own worker, so they run in parallel.
    // Workers are external resources, so they're created (and terminated) here rather than during render.
    const next = { objects: new YoloModel(), surfaces: new YoloModel() }
    // oxlint-disable-next-line react/set-state-in-effect
    setRunners(next)
    return () => {
      next.objects.dispose()
      next.surfaces.dispose()
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
  const counts = tally(frame, names)
  const wallShare = showWalls && frame?.surfaces ? coverage(frame.surfaces, wallClasses) : null
  const loading =
    status.kind === 'loading' && model
      ? { label: model.label, fraction: status.fraction }
      : showWalls && wallStatus.kind === 'loading'
        ? { label: 'the wall model', fraction: wallStatus.fraction }
        : null
  const errors = [status, showWalls ? wallStatus : null].flatMap((s) => (s?.kind === 'error' ? [s.message] : []))
  const modelTimes = [
    frame?.objects && `objects ${formatMs(frame.objects.timings.inference)} ms`,
    frame?.surfaces && `walls ${formatMs(frame.surfaces.timings.inference)} ms`,
  ].filter(Boolean)

  return (
    <div className="app">
      <header className="masthead">
        <h1 className="wordmark">yooolo</h1>
        <p className="tagline">Objects and walls, found by Ultralytics YOLO running entirely in your browser.</p>
      </header>

      <main className="workspace">
        <section className="stage" aria-label="Detection view">
          <Viewport
            objects={status.kind === 'ready' ? runners!.objects : null}
            surfaces={showWalls && wallStatus.kind === 'ready' ? runners!.surfaces : null}
            source={source}
            conf={conf}
            names={names}
            surfaceClasses={wallClasses}
            onFrame={onFrame}
            onError={setNotice}
            onDropImage={openImage}
          >
            {!source && (
              <div className="empty">
                <p className="empty-title">Point a camera at a room, or open a photo.</p>
                <p className="empty-hint">You can also drop an image anywhere in this frame.</p>
                <div className="actions">
                  <button type="button" className="button primary" onClick={startCamera}>
                    Start camera
                  </button>
                  {SAMPLES.map((s) => (
                    <button key={s.label} type="button" className="button on-dark" onClick={() => showSource(s.source)}>
                      {s.label}
                    </button>
                  ))}
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

          <div className="field">
            <h2 className="field-label">Walls</h2>
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
            <p className="hint">
              {wallModel
                ? `Uses ${wallModel.label}, ${formatMB(wallModel.bytes)}.`
                : 'No wall model is installed. Run "uv run scripts/export_model.py yolo26n-sem-ade20k" to add one.'}
            </p>
          </div>

          <fieldset className="field">
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

          <p className="privacy">Everything runs on this device. Video and images are never uploaded.</p>
        </aside>
      </main>
    </div>
  )
}
