import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { clearCanvas, drawOverlay } from './yolo/draw'
import type { YoloModel } from './yolo/model'
import type { DetectResult, SegmentResult } from './yolo/types'

export type Source = { kind: 'camera'; stream: MediaStream } | { kind: 'image'; url: string; name: string }

/** Results for one frame from every model that ran on it. */
export interface Frame {
  objects: DetectResult | null
  surfaces: SegmentResult | null
  /** Milliseconds from capture until every model finished. */
  elapsed: number
}

const IOU = 0.45
/** Minimum time between wall updates on live video (4 per second). */
const WALL_INTERVAL_MS = 250

interface ViewportProps {
  /** Ready-to-run models; null ones are skipped. */
  objects: YoloModel | null
  surfaces: YoloModel | null
  source: Source | null
  conf: number
  names: string[]
  surfaceClasses: readonly number[]
  onFrame: (frame: Frame, live: boolean) => void
  onError: (message: string) => void
  onDropImage: (file: File) => void
  children?: ReactNode
}

function nextVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => resolve())
    else requestAnimationFrame(() => resolve())
  })
}

async function runFrame(
  media: HTMLVideoElement | HTMLImageElement,
  objects: YoloModel | null,
  surfaces: YoloModel | null,
  conf: number,
): Promise<Frame> {
  const t0 = performance.now()
  const options = { conf, iou: IOU }
  // Both models capture the same frame before either awaits, then run in parallel workers.
  const [o, s] = await Promise.all([objects?.run(media, options) ?? null, surfaces?.run(media, options) ?? null])
  return {
    objects: o?.kind === 'detect' ? o : null,
    surfaces: s?.kind === 'semantic' ? s : null,
    elapsed: performance.now() - t0,
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function Viewport({
  objects,
  surfaces,
  source,
  conf,
  names,
  surfaceClasses,
  onFrame,
  onError,
  onDropImage,
  children,
}: ViewportProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  // The camera loop reads these on every frame without restarting.
  const latest = useRef({ conf, names, surfaceClasses, onFrame, onError })
  useEffect(() => {
    latest.current = { conf, names, surfaceClasses, onFrame, onError }
  })

  const show = (frame: Frame, live: boolean) => {
    const { names, surfaceClasses, onFrame } = latest.current
    drawOverlay(canvasRef.current!, { objects: frame.objects, surfaces: frame.surfaces, surfaceClasses, names })
    onFrame(frame, live)
  }

  useEffect(() => {
    clearCanvas(canvasRef.current)
    const video = videoRef.current
    if (!video || source?.kind !== 'camera') return
    video.srcObject = source.stream
    return () => {
      video.srcObject = null
    }
  }, [source])

  // Camera: each model runs in its own loop, one frame in flight at a time, and the overlay
  // combines the latest result from each. Objects set the frame rate; walls change slowly,
  // so the wall model is capped to leave the GPU free for objects.
  useEffect(() => {
    const video = videoRef.current
    if ((!objects && !surfaces) || !video || source?.kind !== 'camera') return
    let cancelled = false
    const current: Frame = { objects: null, surfaces: null, elapsed: 0 }

    const loop = async (model: YoloModel, minInterval: number, setsPace: boolean) => {
      let failures = 0
      while (!cancelled) {
        const started = performance.now()
        await nextVideoFrame(video)
        if (cancelled) return
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) continue
        try {
          const t0 = performance.now()
          const result = await model.run(video, { conf: latest.current.conf, iou: IOU })
          if (cancelled) return
          failures = 0
          if (result.kind === 'detect') current.objects = result
          else current.surfaces = result
          if (setsPace) current.elapsed = performance.now() - t0
          show({ ...current }, setsPace)
        } catch (err) {
          // A single bad frame shouldn't end the session; give up only if it keeps failing.
          if (cancelled) return
          if (++failures >= 10) return latest.current.onError(errorText(err))
        }
        const wait = minInterval - (performance.now() - started)
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    if (objects) loop(objects, 0, true)
    if (surfaces) loop(surfaces, WALL_INTERVAL_MS, !objects)
    return () => {
      cancelled = true
    }
    // show() only reads refs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [objects, surfaces, source])

  // Image: run once, and again whenever the models, confidence, or highlighted surfaces change.
  const imageReady = source?.kind === 'image' && loadedUrl === source.url
  useEffect(() => {
    const image = imageRef.current
    if ((!objects && !surfaces) || !image || !imageReady) return
    let cancelled = false
    runFrame(image, objects, surfaces, conf).then(
      (frame) => !cancelled && show(frame, false),
      (err) => !cancelled && latest.current.onError(errorText(err)),
    )
    return () => {
      cancelled = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [objects, surfaces, imageReady, conf, surfaceClasses])

  const dragHasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

  return (
    <div
      className="viewport"
      data-dragging={dragging || undefined}
      data-live={source?.kind === 'camera' || undefined}
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'))
        if (file) onDropImage(file)
      }}
    >
      {source?.kind === 'camera' && <video ref={videoRef} className="media" autoPlay playsInline muted />}
      {source?.kind === 'image' && (
        <img
          ref={imageRef}
          className="media"
          src={source.url}
          alt={source.name}
          onLoad={() => setLoadedUrl(source.url)}
        />
      )}
      <canvas ref={canvasRef} className="media" aria-hidden="true" />
      <div className="reticle" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      {children}
    </div>
  )
}
