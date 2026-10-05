/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web'
import { cropLabels, decodeEnd2End, decodeRaw, letterbox, type Letterbox } from './postprocess'
import type {
  Engine,
  EnginePreference,
  LoadResult,
  ModelInfo,
  RunOptions,
  RunResult,
  WorkerRequest,
  WorkerResponse,
} from './types'

declare const self: DedicatedWorkerGlobalScope

type GpuNavigator = WorkerNavigator & { gpu?: { requestAdapter(): Promise<unknown | null> } }

let session: ort.InferenceSession | null = null
let model: ModelInfo | null = null
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let input = new Float32Array(0)

// Multi-threaded WebAssembly needs cross-origin isolation (COOP/COEP headers).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1

function post(message: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, transfer)
}

async function fetchModel(id: number, url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Couldn't download the model (${response.status} ${response.statusText}).`)
  const total = Number(response.headers.get('Content-Length')) || 0
  if (!response.body || !total) return new Uint8Array(await response.arrayBuffer())

  const bytes = new Uint8Array(total)
  const reader = response.body.getReader()
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes.set(value, loaded)
    loaded += value.length
    post({ id, type: 'progress', fraction: loaded / total })
  }
  return bytes.subarray(0, loaded)
}

async function webgpuUnavailableReason(): Promise<string | null> {
  const gpu = (navigator as GpuNavigator).gpu
  if (!gpu) return "This browser doesn't support WebGPU."
  try {
    return (await gpu.requestAdapter()) ? null : 'No compatible GPU was found.'
  } catch {
    return 'No compatible GPU was found.'
  }
}

async function createSession(bytes: Uint8Array, preference: EnginePreference): Promise<LoadResult> {
  let fallbackReason: string | undefined
  if (preference !== 'wasm') {
    fallbackReason = (await webgpuUnavailableReason()) ?? undefined
    if (!fallbackReason) {
      try {
        session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] })
        return { engine: 'webgpu' }
      } catch (err) {
        fallbackReason = `WebGPU failed to start: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    if (preference === 'webgpu') throw new Error(fallbackReason)
  }
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] })
  return { engine: 'wasm' satisfies Engine, fallbackReason }
}

async function load(id: number, next: ModelInfo, url: string, preference: EnginePreference) {
  await session?.release()
  session = null
  model = null
  const bytes = await fetchModel(id, url)
  const result = await createSession(bytes, preference)
  model = next
  // The first run compiles GPU shaders and allocates buffers; do it now rather than on the first frame.
  const size = next.imgsz
  await session!.run({ [session!.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size]) })
  post({ id, type: 'loaded', result })
}

function preprocess(image: ImageBitmap, size: number): Letterbox {
  if (!canvas || canvas.width !== size) {
    canvas = new OffscreenCanvas(size, size)
    ctx = canvas.getContext('2d', { willReadFrequently: true })
    input = new Float32Array(3 * size * size)
  }
  const lb = letterbox(image.width, image.height, size)
  ctx!.fillStyle = 'rgb(114, 114, 114)'
  ctx!.fillRect(0, 0, size, size)
  ctx!.drawImage(image, lb.left, lb.top, lb.width, lb.height)
  const { data } = ctx!.getImageData(0, 0, size, size)

  // RGBA bytes -> planar RGB floats in [0, 1].
  const area = size * size
  for (let i = 0, p = 0; i < area; i++, p += 4) {
    input[i] = data[p] / 255
    input[i + area] = data[p + 1] / 255
    input[i + 2 * area] = data[p + 2] / 255
  }
  return lb
}

function decode(output: ort.Tensor, lb: Letterbox, width: number, height: number, options: RunOptions) {
  const { names, task } = model!
  const [, d1, d2] = output.dims
  if (task === 'semantic') {
    if (output.type !== 'uint8') throw new Error(`Expected a uint8 label map, got ${output.type}.`)
    const { labels, labelWidth, labelHeight } = cropLabels(output.data as Uint8Array, d2, d1, model!.imgsz, lb)
    return { kind: 'semantic', labels, labelWidth, labelHeight } as const
  }
  const data = output.data as Float32Array
  if (d2 === 6) return { kind: 'detect', detections: decodeEnd2End(data, d1, options.conf, lb, width, height) } as const
  if (d1 === 4 + names.length) {
    return { kind: 'detect', detections: decodeRaw(data, names.length, d2, options.conf, options.iou, lb, width, height) } as const
  }
  throw new Error(`Unsupported model output shape [${output.dims.join(', ')}].`)
}

async function run(id: number, image: ImageBitmap, options: RunOptions) {
  if (!session || !model) throw new Error('No model is loaded yet.')
  const { width, height } = image
  const size = model.imgsz

  const t0 = performance.now()
  const lb = preprocess(image, size)
  image.close()
  const t1 = performance.now()
  const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) })
  const t2 = performance.now()
  const decoded = decode(outputs[session.outputNames[0]], lb, width, height, options)
  const t3 = performance.now()

  const result: RunResult = {
    ...decoded,
    width,
    height,
    timings: { preprocess: t1 - t0, inference: t2 - t1, postprocess: t3 - t2 },
  }
  post({ id, type: 'result', result }, result.kind === 'semantic' ? [result.labels.buffer] : [])
}

// ONNX Runtime starts its WebAssembly threads from this same script; only the
// top-level worker should handle app messages.
if (!self.name.startsWith('em-pthread')) {
  // Handle one request at a time so a model swap never races a running frame.
  let queue = Promise.resolve()
  self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    const msg = event.data
    queue = queue.then(async () => {
      try {
        if (msg.type === 'load') await load(msg.id, msg.model, msg.url, msg.engine)
        else await run(msg.id, msg.image, msg.options)
      } catch (err) {
        if (msg.type === 'run') msg.image.close()
        post({ id: msg.id, type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })
  })
}
