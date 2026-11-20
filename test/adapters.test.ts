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

test("nvidia normalizes missing metadata gracefully", () => {
  const entry = nvidia.normalize({ id: "acme/bare-model", owned_by: "acme" })
  assert.equal(entry.id, "acme/bare-model")
  assert.equal(entry.family, "acme")
  assert.equal(entry.contextWindow, undefined)
  assert.equal(entry.vision, false)
  assert.equal(entry.tools, undefined)
})

test("opencode normalizes modalities and limits", () => {
  const entry = opencode.normalize({
    id: "oc/vision",
    name: "Vision",
    family: "oc",
    created: 7,
    modalities: { input: ["text", "image/png"] },
    limit: { context: 8192, output: 1024 },
    capabilities: { tools: { supported: true } },
  })
  assert.equal(entry.id, "oc/vision")
  assert.equal(entry.name, "Vision")
  assert.equal(entry.family, "oc")
  assert.equal(entry.created, 7)
  assert.equal(entry.contextWindow, 8192)
  assert.equal(entry.outputLimit, 1024)
  assert.equal(entry.vision, true)
  assert.equal(entry.tools, true)
})

test("opencode classifies 429 as inconclusive", () => {
  assert.equal(opencode.classify(429), undefined)
})

test("nvidia classifies 200 as inconclusive", () => {
  assert.equal(nvidia.classify(200), undefined)
})
