import type { Adapter } from "../types.ts"

/** Zero-priced entries only; everything else needs an OpenCode Console key. */
function isFree(entry: any) {
  const text = entry.cost?.text ?? {}
  return (text.input?.price ?? 0) === 0 && (text.output?.price ?? 0) === 0
}

/**
 * OpenCode's own hosted inference, free tier.
 *
 * Dialect differences from NVIDIA:
 *   - models.dev-shaped metadata (limit, modalities, capabilities, cost)
 *   - Cloudflare rejects requests without a User-Agent (403, error 1010)
 *   - the credential normally comes from the provider's own settings, not a connection
 *   - free models answer 429 FreeUsageLimitError when throttled, which is not a
 *     verdict on availability, and paid models answer 401 without a Console key
 */
export const opencode: Adapter = {
  normalize(entry) {
    const input = entry.modalities?.input ?? []
    return {
      id: entry.id,
      name: entry.name,
      family: entry.family ?? entry.owned_by,
      created: entry.created,
      contextWindow: entry.limit?.context,
      outputLimit: entry.limit?.output,
      vision: input.some((mime) => typeof mime === "string" && mime.startsWith("image")),
      tools: entry.capabilities?.tools?.supported,
      raw: entry,
    }
  },
  select(entries) {
    /**
     * Only the free tier is in scope: probing the paid catalogue would just
     * produce 401s and traffic on a shared endpoint.
     */
    return entries.filter(isFree)
  },
  classify(status) {
    if ([400, 401, 402, 403, 404, 410].includes(status)) return false
    return undefined
  },
}
