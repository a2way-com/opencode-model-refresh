import test from "node:test"
import assert from "node:assert/strict"

import { requestHeaders } from "../src/openai.ts"
import type { ProviderConfig } from "../src/types.ts"

const config: ProviderConfig = {
  adapterID: "opencode",
  providerID: "opencode-go",
  integrationID: "opencode",
  baseURL: "https://example.invalid/v1",
  reasoningField: "reasoning_content",
  refreshMinutes: 60,
  probeConcurrency: 5,
  storageKey: "state:opencode-go",
  statusPath: "/tmp/models.json",
}

test("forwards provider headers", () => {
  const headers = requestHeaders({ ...config, headers: { "x-opencode-org-id": "org" } }, "key") as Record<
    string,
    string
  >
  assert.equal(headers["x-opencode-org-id"], "org")
  assert.equal(headers.Authorization, "Bearer key")
})

test("provider headers cannot override authorization", () => {
  const headers = requestHeaders(
    { ...config, headers: { Authorization: "Bearer wrong" } },
    "key",
  ) as Record<string, string>
  assert.equal(headers.Authorization, "Bearer key")
})

test("adds JSON content type and user agent when configured", () => {
  const headers = requestHeaders({ ...config, userAgent: "opencode/test" }, "key", true) as Record<
    string,
    string
  >
  assert.equal(headers["Content-Type"], "application/json")
  assert.equal(headers["User-Agent"], "opencode/test")
})
