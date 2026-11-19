import type { Adapter } from "../types.ts"

/**
 * NVIDIA NIM (build.nvidia.com).
 *
 * /models entries are usually bare {id, object, created, owned_by}; a few carry
 * context_window, model_type and supports_* flags. Withdrawn models answer 410
 * Gone, unentitled ones 404, and non-chat endpoints fail the chat probe.
 */
export const nvidia: Adapter = {
  normalize(entry) {
    return {
      id: entry.id,
      family: entry.owned_by ?? entry.id.split("/")[0],
      created: entry.created,
      contextWindow: entry.context_window,
      vision: /vlm|vision|omni/i.test(entry.model_type ?? ""),
      tools: entry.supports_tools,
      raw: entry,
    }
  },
  classify(status) {
    if ([400, 403, 404, 410].includes(status)) return false
    return undefined
  },
}
