import test from "node:test"
import assert from "node:assert/strict"

import { makeModel } from "../src/reconcile.ts"
import type { ProviderConfig } from "../src/types.ts"

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

const catalog = {
  id: "catalog-id",
  modelID: "catalog-id",
  providerID: "somewhere-else",
  family: "catalog-family",
  name: "Catalogue Name",
  package: "@catalog/package",
  settings: { baseURL: "https://catalog.invalid" },
  compatibility: { reasoningField: "catalog_reasoning" },
  capabilities: {
    tools: true,
    input: ["text", "image"],
    output: ["text"],
    temperature: false,
  },
  variants: [{ id: "high" }],
  time: { released: 123 },
  cost: [{ input: 1 }],
  status: "beta",
  limit: { context: 8192, output: 1024 },
}

test("merges models.dev metadata into newly discovered models", () => {
  const model = makeModel({ id: "new/model", raw: {} }, undefined, config, catalog)

  assert.equal(model.id, "new/model")
  assert.equal(model.modelID, "new/model")
  assert.equal(model.providerID, "test")
  assert.equal(model.name, "Catalogue Name")
  assert.equal(model.family, "catalog-family")
  assert.equal(model.package, "@catalog/package")
  assert.deepEqual(model.settings, { baseURL: "https://catalog.invalid" })
  assert.equal(model.compatibility.reasoningField, "reasoning_content")
  assert.equal(model.capabilities.tools, true)
  assert.deepEqual(model.capabilities.input, ["text", "image"])
  assert.equal(model.capabilities.temperature, false)
  assert.deepEqual(model.variants, [{ id: "high" }])
  assert.deepEqual(model.time, { released: 123 })
  assert.deepEqual(model.cost, [{ input: 1 }])
  assert.equal(model.status, "beta")
  assert.deepEqual(model.limit, { context: 8192, output: 1024 })
})

test("normalized provider metadata overrides catalogue values", () => {
  const model = makeModel(
    {
      id: "new/model",
      name: "Live Name",
      contextWindow: 4096,
      outputLimit: 512,
      vision: false,
      tools: false,
      raw: {},
    },
    undefined,
    config,
    catalog,
  )

  assert.equal(model.name, "Live Name")
  assert.deepEqual(model.capabilities.input, ["text"])
  assert.equal(model.capabilities.tools, false)
  assert.deepEqual(model.limit, { context: 4096, output: 512 })
})

test("the existing provider template wins for package and compatibility", () => {
  const model = makeModel(
    { id: "new/model", raw: {} },
    {
      package: "@template/package",
      settings: { baseURL: "https://template.invalid" },
      compatibility: { reasoningField: "template_reasoning", extra: true },
    },
    config,
    catalog,
  )

  assert.equal(model.package, "@template/package")
  assert.deepEqual(model.settings, { baseURL: "https://template.invalid" })
  assert.equal(model.compatibility.reasoningField, "reasoning_content")
  assert.equal(model.compatibility.extra, true)
})
