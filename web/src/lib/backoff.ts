export interface Backoff {
  attempts: number
  firstDelayMs: number
  maxDelayMs: number
}

export function backoffDelay(policy: Backoff, failures: number): number | null {
  if (failures < 1 || failures >= policy.attempts) return null
  return Math.min(policy.firstDelayMs * 2 ** (failures - 1), policy.maxDelayMs)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withBackoff<T>(
  attempt: () => Promise<T>,
  policy: Backoff,
  retriable: (err: unknown) => boolean,
  wait: (ms: number) => Promise<void>,
): Promise<T> {
  for (let failures = 1; ; failures++) {
    try {
      return await attempt()
    } catch (err) {
      const delayMs = retriable(err) ? backoffDelay(policy, failures) : null
      if (delayMs === null) throw err
      await wait(delayMs)
    }
  }
}
