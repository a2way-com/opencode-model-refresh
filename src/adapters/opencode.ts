import type { Adapter } from "../types.ts"

/**
 * OpenCode's own hosted inference.
 *
 * Dialect differences from NVIDIA:
 *   - models.dev-shaped metadata (limit, modalities, capabilities, cost)
 *   - Cloudflare rejects requests without a User-Agent (403, error 1010)
 *   - the credential normally comes from the provider's own settings, not a connection
 *   - throttled models answer 429 FreeUsageLimitError, which is not a verdict on
 *     availability, and paid models answer 401 without a Console key
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
      vision: input.some((mime: any) => typeof mime === "string" && mime.startsWith("image")),
      tools: entry.capabilities?.tools?.supported,
      raw: entry,
    }
  },
  classify(status) {
    if ([400, 401, 402, 403, 404, 410].includes(status)) return false
    return undefined
  },
}
