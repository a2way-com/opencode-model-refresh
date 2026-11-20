import test from "node:test"
import assert from "node:assert/strict"

import { probe } from "../src/openai.ts"
import type { Adapter, ProviderConfig } from "../src/types.ts"

const adapter: Adapter = {
  normalize(entry) {
    return { id: entry.id, raw: entry }
  },
  classify(status) {
    return status === 401 ? false : undefined
  },
}

const config: ProviderConfig = {
  adapterID: "test",
  providerID: "test",
  integrationID: "test",
  baseURL: "https://example.invalid/v1",
  reasoningField: "reasoning_content",
  refreshMinutes: 60,
  probeConcurrency: 5,
  storageKey: "state:test",
  statusPath: "/tmp/models.json",
}

function stubStatuses(statuses: number[], headers: Record<string, string> = {}) {
  const original = globalThis.fetch
  let index = 0
  globalThis.fetch = (async () => {
    const status = statuses[Math.min(index++, statuses.length - 1)]
    return new Response("{}", { status, headers })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

async function run(
  statuses: number[],
  oauth = false,
  rateLimits?: Map<string, number>,
  headers?: Record<string, string>,
) {
  const restore = stubStatuses(statuses, headers)
  try {
    return await probe(config, adapter, "key", "model", rateLimits, oauth)
  } finally {
    restore()
  }
}

test("OAuth 401 is inconclusive", async () => {
  assert.equal(await run([401], true), undefined)
})

test("API-key 401 is a definite refusal", async () => {
  assert.equal(await run([401], false), false)
})

test("429 is rate-limited and inconclusive", async () => {
  const rateLimits = new Map<string, number>()
  assert.equal(await run([429], false, rateLimits), undefined)
  assert.equal(rateLimits.has("model"), true)
})

test("429 honors Retry-After", async () => {
  const rateLimits = new Map<string, number>()
  const before = Date.now()
  assert.equal(
    await run([429], false, rateLimits, { "retry-after": "120" }),
    undefined,
  )
  const retryAt = rateLimits.get("model")!
  assert.ok(retryAt >= before + 119_000)
  assert.ok(retryAt <= Date.now() + 121_000)
})

test("400 retries once with max_completion_tokens", async () => {
  assert.equal(await run([400, 200]), true)
})

test("two 400 responses are inconclusive", async () => {
  assert.equal(await run([400, 400]), undefined)
})
