// What a worker can run a model on, as decisions rather than calls, so the
// choice is written once and can be read in a test. A browser with WebGPU
// is asked for a device; a model that cannot run on it (an export without
// fp16, a device the runtime does not support) is loaded on WebAssembly in
// its 8-bit export instead. Anything else is a failure and is reported as
// one: a pipeline that quietly degrades is a pipeline nobody notices is
// broken.

/** The devices the speech workers run on. */
export type Device = 'webgpu' | 'wasm'

/** The exports that need a device and a hardware feature this machine lacks. */
const REFUSED_ON_DEVICE = /Unsupported device|does not support fp16/

/** The export to load for device: the server's choice on a GPU, 8-bit on WebAssembly. */
export function dtypeFor(device: Device, dtype: string): string {
  return device === 'wasm' ? 'q8' : dtype
}

/** Whether a failed model load is the GPU refusing this export, not a real fault. */
export function fallbackToWasm(err: unknown): boolean {
  return REFUSED_ON_DEVICE.test(message(err))
}

/** err as something a member can be shown. */
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const WITHOUT_HALVES: Record<string, string> = { fp16: 'fp32', q4f16: 'q4', q2f16: 'q2', q1f16: 'q1' }

export function withoutHalves(dtype: string): string {
  return WITHOUT_HALVES[dtype] ?? dtype
}

export function needsHalves(dtype: string): boolean {
  return withoutHalves(dtype) !== dtype
}
