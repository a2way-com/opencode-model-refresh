import { RATE_LIMITED_BACKOFF_MS } from "./selection.ts"
import type { Adapter, ProviderConfig, Verdict } from "./types.ts"

const PROBE_TIMEOUT_MS = 30_000
const INVENTORY_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_BACKOFF_MS = 24 * 60 * 60 * 1000

export function requestHeaders(config: ProviderConfig, apiKey: string, json = false) {
  return {
    ...(config.headers ?? {}),
    Authorization: `Bearer ${apiKey}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
    /**
     * Some gateways (Cloudflare in front of opencode.ai) reject requests that
     * do not present a user agent at all.
     */
    ...(config.userAgent ? { "User-Agent": config.userAgent } : {}),
  }
}

/**
 * Respect Retry-After when the provider sends it; otherwise use the normal
 * rate-limit backoff. Values are clamped to a sane range.
 */
function retryAfterMs(response: Response) {
  const value = response.headers.get("retry-after")
  if (value) {
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(1000, seconds * 1000))
    }
    const date = Date.parse(value)
    if (!Number.isNaN(date)) {
      return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(1000, date - Date.now()))
    }
  }
  return RATE_LIMITED_BACKOFF_MS
}

export async function fetchModels(config: ProviderConfig, apiKey: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), INVENTORY_TIMEOUT_MS)
  try {
    const response = await fetch(`${config.baseURL}/models`, {
      signal: controller.signal,
      headers: requestHeaders(config, apiKey),
    })
    if (!response.ok) throw new Error(`/models returned ${response.status}`)
    const payload = await response.json()
    const entries = (Array.isArray(payload?.data) ? payload.data : []).filter(
      (entry: any) => typeof entry?.id === "string",
    )
    if (entries.length === 0) throw new Error("/models returned an empty inventory")
    return entries
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`/models timed out after ${INVENTORY_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
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
  rateLimits?: Map<string, number>,
  oauth = false,
): Promise<Verdict> {
  const attempt = async (tokenField: string) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      return await fetch(`${config.baseURL}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: requestHeaders(config, apiKey, true),
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
    rateLimits?.set(modelID, Date.now() + retryAfterMs(response))
    return undefined
  }
  if (response.ok) return true

  if (response.status === 400) {
    response = await attempt("max_completion_tokens")
    if (!response) return undefined
    if (response.status === 429) {
      rateLimits?.set(modelID, Date.now() + retryAfterMs(response))
      return undefined
    }
    if (response.ok) return true
    if (response.status === 400) return undefined
  }

  /**
   * An OAuth access token can expire; 401 then says nothing about the model's
   * availability. Only API-key credentials treat 401 as a definite refusal.
   */
  if (oauth && response.status === 401) return undefined
  return adapter.classify(response.status)
}
