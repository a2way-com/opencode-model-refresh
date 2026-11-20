export const REFUSED_RETRY_MS = 7 * 24 * 60 * 60 * 1000
export const UNLISTED_RECHECK_MS = 24 * 60 * 60 * 1000
export const RATE_LIMITED_BACKOFF_MS = 15 * 60 * 1000

export interface ProbeVerdict {
  ok?: boolean
  at: number
  rateLimited?: boolean
  /** Epoch milliseconds when a rate-limited model may be probed again. */
  retryAt?: number
}

/**
 * Decide which candidates are due for a probe.
 *
 * - no cached verdict: probe now
 * - definite refusal: wait 7 days
 * - success but no longer listed: wait 24 hours
 * - rate-limited: wait 15 minutes without treating it as a refusal
 * - any other inconclusive result: retry next cycle
 */
export function selectCandidateIDs(
  candidatePool: Iterable<string>,
  probes: Record<string, ProbeVerdict>,
  live: Set<string>,
  now = Date.now(),
): string[] {
  const selected: string[] = []
  for (const id of candidatePool) {
    const verdict = probes[id]
    if (!verdict) {
      selected.push(id)
      continue
    }
    if (verdict.ok === false) {
      if (now - verdict.at > REFUSED_RETRY_MS) selected.push(id)
      continue
    }
    /**
     * A recent rate limit takes precedence over an older success: without
     * this, a 429 on an unlisted-but-working model would wait a full day
     * instead of the provider's Retry-After.
     */
    if (verdict.rateLimited) {
      const retryAt = verdict.retryAt ?? verdict.at + RATE_LIMITED_BACKOFF_MS
      if (now >= retryAt) selected.push(id)
      continue
    }
    if (verdict.ok === true) {
      if (!live.has(id) && now - verdict.at > UNLISTED_RECHECK_MS) selected.push(id)
      continue
    }
    selected.push(id)
  }
  return selected
}
