import test from "node:test"
import assert from "node:assert/strict"

import { nvidia } from "../src/adapters/nvidia.ts"
import { opencode } from "../src/adapters/opencode.ts"

test("nvidia classifies definite refusals as unavailable", () => {
  for (const status of [400, 403, 404, 410]) {
    assert.equal(nvidia.classify(status), false, `status ${status}`)
  }
})

test("nvidia leaves ambiguous statuses inconclusive", () => {
  for (const status of [401, 408, 429, 500, 502, 503]) {
    assert.equal(nvidia.classify(status), undefined, `status ${status}`)
  }
})

test("nvidia normalizes context window and vision metadata", () => {
  const entry = nvidia.normalize({
    id: "acme/vision-model",
    owned_by: "acme",
    created: 123,
    context_window: 4096,
    model_type: "vlm",
    supports_tools: true,
  })

  assert.equal(entry.id, "acme/vision-model")
  assert.equal(entry.contextWindow, 4096)
  assert.equal(entry.vision, true)
  assert.equal(entry.tools, true)
})

test("opencode classifies definite refusals as unavailable", () => {
  for (const status of [400, 401, 402, 403, 404, 410]) {
    assert.equal(opencode.classify(status), false, `status ${status}`)
  }
})

test("opencode leaves ambiguous statuses inconclusive", () => {
  for (const status of [408, 429, 500, 502, 503]) {
    assert.equal(opencode.classify(status), undefined, `status ${status}`)
  }
})

test("opencode selects only zero-priced entries", () => {
  const entries = [
    { id: "free", cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
    { id: "paid", cost: { text: { input: { price: 1 }, output: { price: 2 } } } },
    { id: "missing-cost" },
  ]

  assert.deepEqual(
    opencode.select!(entries, new Set()).map((entry) => entry.id),
    ["free", "missing-cost"],
  )
})
