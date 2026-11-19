import type { Adapter, ProviderConfig, Verdict } from "./types.ts"

const PROBE_TIMEOUT_MS = 30_000

function headers(config: ProviderConfig, apiKey: string, json = false) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
    /**
     * Some gateways (Cloudflare in front of opencode.ai) reject requests that
     * do not present a user agent at all.
     */
    ...(config.userAgent ? { "User-Agent": config.userAgent } : {}),
  }
}

export async function fetchModels(config: ProviderConfig, apiKey: string) {
  const response = await fetch(`${config.baseURL}/models`, {
    headers: headers(config, apiKey),
  })
  if (!response.ok) throw new Error(`/models returned ${response.status}`)
  const payload = await response.json()
  const entries = (Array.isArray(payload?.data) ? payload.data : []).filter(
    (entry) => typeof entry?.id === "string",
  )
  if (entries.length === 0) throw new Error("/models returned an empty inventory")
  return entries
}

/**
 * Probe one model with a minimal chat completion.
 *
 * The first attempt uses max_tokens; a 400 retries with max_completion_tokens,
 * which some OpenAI-compatible APIs require. Two rejections in a row are treated
 * as a dialect problem and reported as inconclusive, never as "model is gone",
 * so an unfamiliar provider cannot wipe its own inventory.
 */
export async function probe(
  config: ProviderConfig,
  adapter: Adapter,
  apiKey: string,
  modelID: string,
  rateLimited?: Set<string>,
): Promise<Verdict> {
  const attempt = async (tokenField: string) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      return await fetch(`${config.baseURL}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: headers(config, apiKey, true),
        body: JSON.stringify({
          model: modelID,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          [tokenField]: 1,
          stream: false,
        }),
      })
    } catch {
      return undefined
    } finally {
      clearTimeout(timeout)
    }
  }

  let response = await attempt("max_tokens")
  if (!response) return undefined
  if (response.status === 429) {
    rateLimited?.add(modelID)
    return undefined
  }
  if (response.ok) return true

  if (response.status === 400) {
    response = await attempt("max_completion_tokens")
    if (!response) return undefined
    if (response.status === 429) {
      rateLimited?.add(modelID)
      return undefined
    }
    if (response.ok) return true
    if (response.status === 400) return undefined
  }

  return adapter.classify(response.status)
}
