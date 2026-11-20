import test from "node:test"
import assert from "node:assert/strict"

import { resolveBinding } from "../src/binding.ts"

const adapters = { nvidia: {}, opencode: {} }

test("uses the adapter matching the provider ID", () => {
  assert.deepEqual(resolveBinding({ providerID: "nvidia", adapters }), {
    adapterID: "nvidia",
    integrationID: "nvidia",
  })
})

test("falls back to the provider integrationID for variants", () => {
  assert.deepEqual(
    resolveBinding({ providerID: "opencode-go", providerIntegrationID: "opencode", adapters }),
    { adapterID: "opencode", integrationID: "opencode" },
  )
})

test("explicit adapter and integration overrides win", () => {
  assert.deepEqual(
    resolveBinding({
      providerID: "acme",
      providerIntegrationID: "nvidia",
      adapter: "opencode",
      integrationID: "nvidia",
      adapters,
    }),
    { adapterID: "opencode", integrationID: "nvidia" },
  )
})

test("leaves unknown providers unresolved", () => {
  assert.deepEqual(resolveBinding({ providerID: "unknown", adapters }), {
    adapterID: "unknown",
    integrationID: "unknown",
  })
})
