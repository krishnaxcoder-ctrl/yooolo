/** One entry in public/models/manifest.json, written by scripts/export_model.py. */
export interface ModelInfo {
  id: string
  label: string
  file: string
  imgsz: number
  task: 'detect' | 'semantic'
  /**
   * end2end: NMS-free [1, maxDet, 6] boxes. raw: [1, 4 + classes, anchors] boxes, needs NMS.
   * labelmap: [1, H, W] uint8 class id per pixel.
   */
  format: 'end2end' | 'raw' | 'labelmap'
  bytes: number
  names: string[]
}

export type Engine = 'webgpu' | 'wasm'
export type EnginePreference = Engine | 'auto'

export interface Detection {
  /** x1, y1, x2, y2 in source pixels. */
  box: [number, number, number, number]
  score: number
  classId: number
}

export interface Timings {
  preprocess: number
  inference: number
  postprocess: number
}

export interface RunOptions {
  /** Minimum confidence, 0 to 1. Detection only. */
  conf: number
  /** IoU threshold for NMS. Ignored by NMS-free models. */
  iou: number
}

interface BaseResult {
  /** Source size in pixels. */
  width: number
  height: number
  timings: Timings
}

export interface DetectResult extends BaseResult {
  kind: 'detect'
  detections: Detection[]
}

/** A class id per pixel, covering the whole source at a lower resolution. */
export interface SegmentResult extends BaseResult {
  kind: 'semantic'
  labels: Uint8Array
  labelWidth: number
  labelHeight: number
}

export type RunResult = DetectResult | SegmentResult

export interface LoadResult {
  engine: Engine
  /** Set when "auto" could not use WebGPU and fell back to WebAssembly. */
  fallbackReason?: string
}

export type WorkerRequest =
  | { id: number; type: 'load'; model: ModelInfo; url: string; engine: EnginePreference }
  | { id: number; type: 'run'; image: ImageBitmap; options: RunOptions }

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'loaded'; result: LoadResult }
  | { id: number; type: 'result'; result: RunResult }
  | { id: number; type: 'error'; message: string }
