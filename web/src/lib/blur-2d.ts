import type { BlurCanvas, Compositor, MaskUpload } from '@/lib/blur-gl'
import { blurPlan, featherRadius, writeMaskAlpha } from '@/lib/mask'

const BLUR_DOWNSCALE = 4
const FILTERLESS_DOWNSCALE = 8

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function scratch(): BlurCanvas {
  return typeof OffscreenCanvas === 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1)
}

function context(canvas: BlurCanvas, alpha: boolean): Context2D {
  const ctx = canvas.getContext('2d', { alpha }) as Context2D | null
  if (!ctx) throw new Error('this browser cannot composite a blurred camera')
  return ctx
}

export class CanvasCompositor implements Compositor {
  readonly lost = false

  private readonly output: Context2D
  private readonly background = scratch()
  private readonly subject = scratch()
  private readonly maskCanvas = scratch()
  private readonly stencil = scratch()
  private readonly backgroundCtx = context(this.background, false)
  private readonly subjectCtx = context(this.subject, true)
  private readonly maskCtx = context(this.maskCanvas, true)
  private readonly stencilCtx = context(this.stencil, true)
  private readonly canFilter: boolean
  private plan = blurPlan(1, 1)
  private size: [number, number] = [0, 0]
  private mask: MaskUpload | null = null
  private maskImage: ImageData | null = null
  private stencilDirty = false

  constructor(canvas: BlurCanvas) {
    this.output = context(canvas, false)
    this.canFilter = 'filter' in this.backgroundCtx
  }

  uploadMask(mask: MaskUpload): void {
    this.mask = mask
    this.stencilDirty = true
  }

  clearMask(): void {
    this.mask = null
  }

  render(image: CanvasImageSource, width: number, height: number): void {
    this.resize(width, height)
    if (!this.mask) {
      this.output.drawImage(image, 0, 0, width, height)
      return
    }
    this.paintBackground(image, width, height)
    this.paintSubject(image, this.mask, width, height)
    this.output.drawImage(this.subject, 0, 0)
  }

  private resize(width: number, height: number): void {
    if (this.size[0] === width && this.size[1] === height) return
    const canvas = this.output.canvas
    canvas.width = width
    canvas.height = height
    this.subject.width = width
    this.subject.height = height
    this.plan = blurPlan(width, height, this.canFilter ? BLUR_DOWNSCALE : FILTERLESS_DOWNSCALE)
    this.background.width = this.plan.width + 2 * this.plan.pad
    this.background.height = this.plan.height + 2 * this.plan.pad
    this.size = [width, height]
  }

  private paintBackground(image: CanvasImageSource, width: number, height: number): void {
    const { pad, radius } = this.plan
    this.backgroundCtx.imageSmoothingEnabled = true
    this.backgroundCtx.imageSmoothingQuality = 'high'
    this.backgroundCtx.filter = this.canFilter ? `blur(${radius}px)` : 'none'
    this.backgroundCtx.drawImage(image, pad, pad, this.plan.width, this.plan.height)
    this.backgroundCtx.filter = 'none'

    this.output.imageSmoothingEnabled = true
    this.output.imageSmoothingQuality = 'low'
    this.output.drawImage(this.background, pad, pad, this.plan.width, this.plan.height, 0, 0, width, height)
  }

  private paintSubject(image: CanvasImageSource, mask: MaskUpload, width: number, height: number): void {
    this.subjectCtx.globalCompositeOperation = 'source-over'
    this.subjectCtx.drawImage(image, 0, 0, width, height)
    if (this.stencilDirty) this.buildStencil(mask)
    this.subjectCtx.globalCompositeOperation = 'destination-in'
    this.subjectCtx.imageSmoothingEnabled = true
    this.subjectCtx.imageSmoothingQuality = 'low'
    this.subjectCtx.drawImage(this.stencil, 0, 0, mask.width, mask.height, 0, 0, width, height)
    this.subjectCtx.globalCompositeOperation = 'source-over'
  }

  private buildStencil(mask: MaskUpload): void {
    const image = this.maskImageFor(mask)
    writeMaskAlpha(mask.values, image.data)
    this.maskCtx.putImageData(image, 0, 0)
    if (this.stencil.width !== mask.width || this.stencil.height !== mask.height) {
      this.stencil.width = mask.width
      this.stencil.height = mask.height
    }
    this.stencilCtx.clearRect(0, 0, mask.width, mask.height)
    this.stencilCtx.filter = this.canFilter ? `blur(${featherRadius(mask.width)}px)` : 'none'
    this.stencilCtx.drawImage(this.maskCanvas, 0, 0)
    this.stencilCtx.filter = 'none'
    this.stencilDirty = false
  }

  private maskImageFor(mask: MaskUpload): ImageData {
    const known = this.maskImage
    if (known && known.width === mask.width && known.height === mask.height) return known
    const image = new ImageData(mask.width, mask.height)
    this.maskImage = image
    this.maskCanvas.width = mask.width
    this.maskCanvas.height = mask.height
    return image
  }
}
