/**
 * Errors produced by partially reloaded development builds. They are not a
 * provider verdict and should never resurface in the timeline.
 */
const STALE_ERROR_PATTERNS = [
  "isGuarded is not defined",
  "PROBE_CONCURRENCY is not defined",
  "REFUSED_RETRY_MS is not defined",
  "resolveApiKey is not defined",
  "headers is not defined",
  "isFree is not defined",
  "undefined is not an object (evaluating '[id, ok]')",
]

export function isStaleHistoryError(error: unknown): boolean {
  return (
    typeof error === "string" && STALE_ERROR_PATTERNS.some((pattern) => error.includes(pattern))
  )
}

export interface HistoryEntry {
  at: string
  provider: string
  added: string[]
  removed: string[]
  guarded?: boolean
  error?: string
}

/**
 * Render the change timeline. The file is overwritten each time, so the
 * baseline inventory can be appended on every render without accumulating
 * duplicate blocks.
 */
export function buildHistoryLines(
  history: HistoryEntry[],
  lastGood: Iterable<string>,
  now = new Date().toISOString(),
): string[] {
  const lines: string[] = []
  for (const entry of history) {
    const added = Array.isArray(entry?.added) ? entry.added : []
    const removed = Array.isArray(entry?.removed) ? entry.removed : []
    const summary = [`${entry.at}: +${added.length} -${removed.length}`]
    if (entry.guarded) summary.push("guard")
    if (entry.error) summary.push(`error: ${entry.error}`)
    if (!entry.guarded && !entry.error && added.length === 0 && removed.length === 0) {
      summary.push("no change")
    }
    lines.push(summary.join(" | "))
    for (const id of added) lines.push(`+ ${id}`)
    for (const id of removed) lines.push(`- ${id}`)
  }

  const hasChanges = history.some(
    (entry) => (entry?.added?.length ?? 0) > 0 || (entry?.removed?.length ?? 0) > 0,
  )
  if (!hasChanges) {
    const baseline = [...lastGood]
    if (baseline.length > 0) {
      lines.push(`${now}: baseline inventory`)
      for (const id of baseline) lines.push(`+ ${id}`)
    } else if (lines.length === 0) {
      lines.push("No models recorded yet.")
    }
  }
  return lines
}
