import type {
  EnginePreference,
  LoadResult,
  ModelInfo,
  RunOptions,
  RunResult,
  WorkerRequest,
  WorkerResponse,
} from './types'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
type Source = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement

interface Pending {
  resolve: (message: WorkerResponse) => void
  reject: (error: Error) => void
  onProgress?: (fraction: number) => void
}

function sourceSize(source: Source): [number, number] {
  if (source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight]
  if (source instanceof HTMLImageElement) return [source.naturalWidth, source.naturalHeight]
  return [source.width, source.height]
}

/**
 * Runs one YOLO model (object detection or semantic segmentation) in its own Web Worker,
 * so inference never blocks the page and several models can run side by side.
 * Framework-agnostic: works with any video, image, or canvas element.
 */
export class YoloModel {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'yolo-model' })
  private pending = new Map<number, Pending>()
  private nextId = 1
  private model: ModelInfo | null = null
  private capture: OffscreenCanvas | null = null

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data
      const pending = this.pending.get(msg.id)
      if (!pending) return
      if (msg.type === 'progress') return pending.onProgress?.(msg.fraction)
      this.pending.delete(msg.id)
      if (msg.type === 'error') pending.reject(new Error(msg.message))
      else pending.resolve(msg)
    })
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The model worker stopped unexpectedly.')
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
  }

  private request(
    message: DistributiveOmit<WorkerRequest, 'id'>,
    transfer: Transferable[] = [],
    onProgress?: (fraction: number) => void,
  ): Promise<WorkerResponse> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      this.worker.postMessage({ ...message, id }, transfer)
    })
  }

  /** Downloads a model and prepares it on the GPU (WebGPU) or CPU (WebAssembly). */
  async load(
    model: ModelInfo,
    url: string,
    engine: EnginePreference = 'auto',
    onProgress?: (fraction: number) => void,
  ): Promise<LoadResult> {
    this.model = null
    const msg = await this.request({ type: 'load', model, url, engine }, [], onProgress)
    if (msg.type !== 'loaded') throw new Error('Unexpected reply from the model worker.')
    this.model = model
    return msg.result
  }

  /**
   * Runs the model on the current frame of a video, or on an image or canvas.
   * Boxes come back in source pixels; label maps cover the whole source.
   */
  async run(source: Source, options: RunOptions): Promise<RunResult> {
    if (!this.model) throw new Error('Load a model before running it.')
    const [width, height] = sourceSize(source)
    if (!width || !height) throw new Error('The source has no image yet.')

    // Downscale on the way to the worker; the model never sees more than imgsz pixels anyway.
    // drawImage + transferToImageBitmap is used instead of createImageBitmap(source, { resize… }),
    // which fails with "could not be allocated" for camera frames on some GPUs.
    // Everything up to the first await runs synchronously, so models started together see the same frame.
    const scale = Math.min(1, this.model.imgsz / Math.max(width, height))
    const t0 = performance.now()
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    this.capture ??= new OffscreenCanvas(w, h)
    if (this.capture.width !== w || this.capture.height !== h) {
      this.capture.width = w
      this.capture.height = h
    }
    const ctx = this.capture.getContext('2d')
    if (!ctx) throw new Error('This browser could not create a 2D canvas.')
    ctx.imageSmoothingQuality = 'medium'
    ctx.drawImage(source, 0, 0, w, h)
    const image = this.capture.transferToImageBitmap()
    const capture = performance.now() - t0

    const msg = await this.request({ type: 'run', image, options }, [image])
    if (msg.type !== 'result') throw new Error('Unexpected reply from the model worker.')
    const { result } = msg
    if (result.kind === 'detect') {
      for (const d of result.detections) d.box = d.box.map((v) => v / scale) as typeof d.box
    }
    return { ...result, width, height, timings: { ...result.timings, preprocess: result.timings.preprocess + capture } }
  }

  dispose() {
    this.worker.terminate()
    for (const pending of this.pending.values()) pending.reject(new Error('The model was closed.'))
    this.pending.clear()
  }
}
