// The arithmetic both ONNX models in the speech workers need before they
// are asked anything: how many values a tensor of a declared shape holds,
// and the 64-bit integers a token list or a speaker id is fed as.

/**
 * The largest dimension a model this app runs could declare. ONNX Runtime
 * reports a dimension it leaves open as -1 on one backend and as the
 * unsigned -1 (4294967295) on another, and either would ask for a tensor
 * nothing can hold.
 */
const MAX_DIMENSION = 1 << 20

/** Whether a declared dimension is a real size rather than one left open. */
export function known(dim: unknown): dim is number {
  return typeof dim === 'number' && dim >= 1 && dim <= MAX_DIMENSION
}

/** How many values a tensor of these dimensions holds. */
export function size(dims: readonly number[] | undefined): number {
  return (dims ?? [1]).reduce((total, dim) => total * (known(dim) ? dim : 1), 1)
}

/** count copies of value, as the 64-bit integers a model takes. */
export function fixed(count: number, value: number): BigInt64Array {
  return BigInt64Array.from({ length: count }, () => BigInt(value))
}
