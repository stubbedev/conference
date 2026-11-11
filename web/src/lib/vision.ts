// The segmentation model, loaded on demand. It is a 250 KB TFLite file and
// a WebAssembly runtime, both served by this app from its own origin: no
// third-party CDN, because a call should not tell anyone else that it
// started and a strict content policy would refuse it anyway. The runtime
// is imported only when blur is first switched on, and the loaded
// segmenter is kept for the session, so turning blur off and on again
// costs nothing.

import type { ImageSegmenter, ImageSource } from '@mediapipe/tasks-vision'

import { loadChunk } from '@/lib/chunks'
import type { SegmentShape } from '@/lib/mask'

const MODELS: Record<SegmentShape, string> = {
  landscape: `${import.meta.env.BASE_URL}vision/selfie_segmenter_landscape.tflite`,
  square: `${import.meta.env.BASE_URL}vision/selfie_segmenter.tflite`,
}

const WASM_PATH = `${import.meta.env.BASE_URL}vision/wasm`

export interface Mask {
  values: Float32Array
  width: number
  height: number
}

export interface Segmenter {
  /** One confidence per mask pixel, or null when this frame gave nothing. */
  confidence(frame: CanvasImageSource, timestampMs: number): Mask | null
  close(): void
}

/** Which model suits a camera of this shape. */
export { modelFor, type SegmentShape } from '@/lib/mask'

async function create(shape: SegmentShape): Promise<Segmenter> {
  const { FilesetResolver, ImageSegmenter: SegmenterClass } = await loadChunk('the background-blur runtime', () => import('@mediapipe/tasks-vision'))

  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH)
  const open = (delegate: 'GPU' | 'CPU'): Promise<ImageSegmenter> =>
    SegmenterClass.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS[shape], delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })

  let segmenter: ImageSegmenter
  try {
    segmenter = await open('GPU')
  } catch (gpuError) {
    try {
      segmenter = await open('CPU')
    } catch (cpuError) {
      throw new Error('the background-blur model could not start', { cause: [gpuError, cpuError] })
    }
  }

  return {
    confidence(frame: CanvasImageSource, timestampMs: number): Mask | null {
      const result = segmenter.segmentForVideo(frame as ImageSource, timestampMs)
      try {
        const mask = result.confidenceMasks?.[0]
        if (!mask) return null

        return { values: Float32Array.from(mask.getAsFloat32Array()), width: mask.width, height: mask.height }
      } finally {
        result.close()
      }
    },
    close() {
      segmenter.close()
    },
  }
}

const loading = new Map<SegmentShape, Promise<Segmenter>>()

/**
 * loadSegmenter returns the shared segmenter built for that camera shape,
 * loading the runtime and the model the first time it is asked for.
 */
export function loadSegmenter(shape: SegmentShape): Promise<Segmenter> {
  const known = loading.get(shape)
  if (known) return known

  const pending = create(shape).catch((err: unknown) => {
    loading.delete(shape)
    throw err
  })

  loading.set(shape, pending)

  return pending
}
