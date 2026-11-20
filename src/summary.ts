import type { HistoryEntry } from "./history.ts"

export interface Summary {
  provider: string
  offered?: number
  probed?: number
  ok?: number
  refused?: number
  guarded?: boolean
  error?: string
}

export function formatSummary(providers: Summary[]) {
  if (providers.length === 0) return "No providers are configured."
  return providers
    .map((result) => {
      if (result.error) return `${result.provider}: ${result.error}`
      const parts = [`${result.offered ?? 0} model(s)`]
      if (result.probed) {
        const ok = result.ok ?? 0
        const refused = result.refused ?? 0
        const inconclusive = Math.max(0, result.probed - ok - refused)
        const detail = [
          ok ? `${ok} ok` : "",
          refused ? `${refused} refused` : "",
          inconclusive ? `${inconclusive} inconclusive` : "",
        ].filter(Boolean)
        parts.push(`${result.probed} probed${detail.length ? ` (${detail.join(", ")})` : ""}`)
      }
      if (result.guarded) parts.push("guard triggered")
      return `${result.provider}: ${parts.join(", ")}`
    })
    .join("\n")
}

/**
 * Format recent history events for a toast or dialog. Toasts have limited
 * space, so older events are summarized instead of listed.
 */
export function formatHistory(events: HistoryEntry[], limit = 10) {
  if (events.length === 0) return "No refresh history yet."
  const lines: string[] = []
  for (const event of events.slice(0, limit)) {
    const added = Array.isArray(event?.added) ? event.added : []
    const removed = Array.isArray(event?.removed) ? event.removed : []
    const summary = [`${event.at} ${event.provider}: +${added.length} -${removed.length}`]
    if (event.guarded) summary.push("guard")
    if (event.error) summary.push(`error: ${event.error}`)
    if (!event.guarded && !event.error && added.length === 0 && removed.length === 0) {
      summary.push("no change")
    }
    lines.push(summary.join(" | "))
    for (const id of added) lines.push(`+ ${id}`)
    for (const id of removed) lines.push(`- ${id}`)
  }
  if (events.length > limit) lines.push(`… ${events.length - limit} older event(s)`)
  return lines.join("\n")
}
