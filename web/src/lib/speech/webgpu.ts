// Whether this browser can run the speech engines on its own, which
// means WebGPU for transcription: the wasm backend is far too slow for a
// whisper-sized model to keep up with a conversation.

/** Whether WebGPU can give this browser a device to run models on. */
export async function webgpuAvailable(): Promise<boolean> {
  if (!('gpu' in navigator)) return false
  const adapter = await navigator.gpu?.requestAdapter()
  return Boolean(adapter)
}

export async function webgpuHalves(): Promise<boolean> {
  const adapter = await navigator.gpu?.requestAdapter()
  return adapter?.features.has('shader-f16') ?? false
}
