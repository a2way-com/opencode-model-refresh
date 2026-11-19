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
