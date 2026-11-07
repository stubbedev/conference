import { EDGE_HIGH, EDGE_LOW, EDGE_RANGE_SIGMA, EDGE_REACH, EDGE_SPATIAL_SIGMA } from '@/lib/edge'
import { blurPlan, type BlurPlan } from '@/lib/mask'

export const MAX_BLUR_RADIUS = 32
const BLUR_DOWNSCALE = 4
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i

const float = (value: number): string => (Number.isInteger(value) ? value.toFixed(1) : String(value))

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`

const SHRINK = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D frame;
uniform vec2 texel;
out vec4 colour;
void main() {
  vec2 at = vec2(uv.x, 1.0 - uv.y);
  colour = 0.25 * (
    texture(frame, at + vec2(-texel.x, -texel.y)) +
    texture(frame, at + vec2(texel.x, -texel.y)) +
    texture(frame, at + vec2(-texel.x, texel.y)) +
    texture(frame, at + vec2(texel.x, texel.y))
  );
}`

const BLUR = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D source;
uniform vec2 stride;
uniform int radius;
out vec4 colour;
void main() {
  float sigma = max(1.0, float(radius) / 2.0);
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -radius; i <= radius; i++) {
    float weight = exp(-float(i * i) / (2.0 * sigma * sigma));
    sum += weight * texture(source, uv + stride * float(i));
    total += weight;
  }
  colour = sum / total;
}`

const PACK = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D shrunk;
uniform sampler2D mask;
layout(location = 0) out vec4 packed;
layout(location = 1) out vec4 edge;
void main() {
  ivec2 size = textureSize(mask, 0);
  ivec2 texel = ivec2(gl_FragCoord.xy);
  float centre = texelFetch(mask, texel, 0).r;
  float mixed = 0.0;
  for (int j = ${EDGE_REACH.from}; j <= ${EDGE_REACH.to}; j++) {
    for (int i = ${EDGE_REACH.from}; i <= ${EDGE_REACH.to}; i++) {
      ivec2 at = clamp(texel + ivec2(i, j), ivec2(0), size - 1);
      if (texelFetch(mask, at, 0).r != centre) mixed = 1.0;
    }
  }
  vec2 image = (vec2(texel) + 0.5) / vec2(size);
  packed = vec4(texture(shrunk, vec2(image.x, 1.0 - image.y)).rgb, centre);
  edge = vec4(mixed, 0.0, 0.0, 1.0);
}`

const COMPOSITE = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D frame;
uniform sampler2D background;
uniform sampler2D packed;
uniform sampler2D edge;
uniform bool masked;
out vec4 colour;
void main() {
  vec2 image = vec2(uv.x, 1.0 - uv.y);
  vec3 here = texture(frame, image).rgb;
  if (!masked) {
    colour = vec4(here, 1.0);
    return;
  }
  ivec2 size = textureSize(packed, 0);
  vec2 centre = image * vec2(size) - 0.5;
  ivec2 base = ivec2(floor(centre));
  ivec2 home = clamp(base, ivec2(0), size - 1);
  float alpha;
  if (texelFetch(edge, home, 0).r < 0.5) {
    alpha = texelFetch(packed, home, 0).a;
  } else {
    float weights = 0.0;
    float weighted = 0.0;
    for (int j = ${EDGE_REACH.from}; j <= ${EDGE_REACH.to}; j++) {
      for (int i = ${EDGE_REACH.from}; i <= ${EDGE_REACH.to}; i++) {
        ivec2 texel = base + ivec2(i, j);
        vec4 neighbour = texelFetch(packed, clamp(texel, ivec2(0), size - 1), 0);
        vec2 offset = vec2(texel) - centre;
        float spatial = exp(-dot(offset, offset) / ${float(2 * EDGE_SPATIAL_SIGMA * EDGE_SPATIAL_SIGMA)});
        vec3 difference = here - neighbour.rgb;
        float range = exp(-dot(difference, difference) / ${float(2 * EDGE_RANGE_SIGMA * EDGE_RANGE_SIGMA)});
        float weight = spatial * range + spatial * 1e-6;
        weights += weight;
        weighted += weight * neighbour.a;
      }
    }
    alpha = weighted / weights;
  }
  alpha = smoothstep(${float(EDGE_LOW)}, ${float(EDGE_HIGH)}, alpha);
  colour = vec4(mix(texture(background, uv).rgb, here, alpha), 1.0);
}`

type Gl = WebGL2RenderingContext

function compile(gl: Gl, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('blur: the GPU refused to create a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`blur: a shader did not compile: ${gl.getShaderInfoLog(shader) ?? 'no log'}`)
  }
  return shader
}

interface Program {
  program: WebGLProgram
  uniform(name: string): WebGLUniformLocation
}

function link(gl: Gl, fragment: string): Program {
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`blur: a shader program did not link: ${gl.getProgramInfoLog(program) ?? 'no log'}`)
  }
  const locations = new Map<string, WebGLUniformLocation>()
  return {
    program,
    uniform(name) {
      const known = locations.get(name)
      if (known) return known
      const location = gl.getUniformLocation(program, name)
      if (!location) throw new Error(`blur: the shader has no uniform ${name}`)
      locations.set(name, location)
      return location
    },
  }
}

function texture(gl: Gl, filter: number): WebGLTexture {
  const created = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, created)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return created
}

interface Target {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
}

function target(gl: Gl, ...extra: WebGLTexture[]): Target {
  const made = texture(gl, gl.LINEAR)
  const framebuffer = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, made, 0)
  extra.forEach((attachment, index) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1 + index, gl.TEXTURE_2D, attachment, 0)
  })
  if (extra.length > 0) gl.drawBuffers([gl.COLOR_ATTACHMENT0, ...extra.map((_, index) => gl.COLOR_ATTACHMENT1 + index)])
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { texture: made, framebuffer }
}

function allocate(gl: Gl, made: WebGLTexture, format: number, width: number, height: number): void {
  gl.bindTexture(gl.TEXTURE_2D, made)
  const [layout, type] = format === gl.R8 ? [gl.RED, gl.UNSIGNED_BYTE] : [gl.RGBA, gl.UNSIGNED_BYTE]
  gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, layout, type, null)
}

export type BlurCanvas = HTMLCanvasElement | OffscreenCanvas

export interface MaskUpload {
  values: Float32Array
  width: number
  height: number
}

export interface Compositor {
  readonly lost: boolean
  uploadMask(mask: MaskUpload): void
  clearMask(): void
  render(image: TexImageSource & CanvasImageSource, width: number, height: number): void
}

let gpu: boolean | null = null

export function gpuCompositing(): boolean {
  gpu ??= probeGpu()
  return gpu
}

function probeGpu(): boolean {
  const probe = typeof OffscreenCanvas === 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1)
  const gl = probe.getContext('webgl2') as Gl | null
  if (!gl) return false
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return !SOFTWARE_RENDERER.test(renderer)
}

export class GlCompositor implements Compositor {
  private readonly gl: Gl
  private readonly shrink: Program
  private readonly blur: Program
  private readonly pack: Program
  private readonly composite: Program
  private readonly frame: WebGLTexture
  private readonly mask: WebGLTexture
  private readonly edge: WebGLTexture
  private readonly packed: Target
  private readonly shrunk: Target
  private readonly across: Target
  private readonly background: Target
  private maskBytes = new Uint8Array(0)
  private maskSize: [number, number] = [0, 0]
  private small: [number, number] = [0, 0]
  private plan = blurPlan(1, 1, BLUR_DOWNSCALE)
  private planFor: [number, number] = [0, 0]

  constructor(canvas: BlurCanvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false }) as Gl | null
    if (!gl) throw new Error('this browser cannot run the background blur on the GPU (no WebGL2)')
    this.gl = gl
    this.shrink = link(gl, SHRINK)
    this.blur = link(gl, BLUR)
    this.pack = link(gl, PACK)
    this.composite = link(gl, COMPOSITE)
    this.frame = texture(gl, gl.LINEAR)
    this.mask = texture(gl, gl.NEAREST)
    this.edge = texture(gl, gl.NEAREST)
    this.packed = target(gl, this.edge)
    this.shrunk = target(gl)
    this.across = target(gl)
    this.background = target(gl)
    gl.bindVertexArray(gl.createVertexArray())
  }

  get lost(): boolean {
    return this.gl.isContextLost()
  }

  uploadMask(mask: MaskUpload): void {
    const gl = this.gl
    const length = mask.width * mask.height
    if (this.maskBytes.length !== length) this.maskBytes = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) this.maskBytes[index] = (mask.values[index] ?? 0) * 255
    gl.bindTexture(gl.TEXTURE_2D, this.mask)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, this.maskBytes)
    if (this.maskSize[0] !== mask.width || this.maskSize[1] !== mask.height) {
      allocate(gl, this.packed.texture, gl.RGBA8, mask.width, mask.height)
      allocate(gl, this.edge, gl.R8, mask.width, mask.height)
      this.maskSize = [mask.width, mask.height]
    }
  }

  clearMask(): void {
    this.maskSize = [0, 0]
  }

  render(image: TexImageSource, width: number, height: number): void {
    const gl = this.gl
    if (this.planFor[0] !== width || this.planFor[1] !== height) {
      this.plan = blurPlan(width, height, BLUR_DOWNSCALE)
      this.planFor = [width, height]
    }
    const plan = this.plan
    const canvas = gl.canvas
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.frame)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)

    const masked = this.maskSize[0] > 0
    if (masked) {
      this.shrinkFrame(width, height, plan)
      this.packMask()
      this.blurBackground(plan)
    }

    this.draw(this.composite, null, width, height, { frame: this.frame, ...(masked ? { background: this.background.texture, packed: this.packed.texture, edge: this.edge } : {}) })
    gl.uniform1i(this.composite.uniform('masked'), masked ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private draw(program: Program, into: Target | null, width: number, height: number, textures: Record<string, WebGLTexture>): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, into?.framebuffer ?? null)
    gl.viewport(0, 0, width, height)
    gl.useProgram(program.program)
    Object.entries(textures).forEach(([name, bound], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, bound)
      gl.uniform1i(program.uniform(name), unit)
    })
  }

  private shrinkFrame(width: number, height: number, plan: BlurPlan): void {
    const gl = this.gl
    if (this.small[0] !== plan.width || this.small[1] !== plan.height) {
      for (const pass of [this.shrunk, this.across, this.background]) allocate(gl, pass.texture, gl.RGBA8, plan.width, plan.height)
      this.small = [plan.width, plan.height]
    }
    this.draw(this.shrink, this.shrunk, plan.width, plan.height, { frame: this.frame })
    gl.uniform2f(this.shrink.uniform('texel'), 1 / width, 1 / height)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private packMask(): void {
    this.draw(this.pack, this.packed, this.maskSize[0], this.maskSize[1], { shrunk: this.shrunk.texture, mask: this.mask })
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3)
  }

  private blurBackground(plan: BlurPlan): void {
    const gl = this.gl
    const radius = Math.min(plan.radius, MAX_BLUR_RADIUS)

    this.draw(this.blur, this.across, plan.width, plan.height, { source: this.shrunk.texture })
    gl.uniform1i(this.blur.uniform('radius'), radius)
    gl.uniform2f(this.blur.uniform('stride'), 1 / plan.width, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    this.draw(this.blur, this.background, plan.width, plan.height, { source: this.across.texture })
    gl.uniform2f(this.blur.uniform('stride'), 0, 1 / plan.height)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
