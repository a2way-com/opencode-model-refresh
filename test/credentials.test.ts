import test from "node:test"
import assert from "node:assert/strict"

import { credentialOf } from "../src/credentials.ts"

test("reads key credentials", () => {
  assert.deepEqual(credentialOf({ type: "key", key: "secret" }), {
    token: "secret",
    oauth: false,
  })
})

test("reads OAuth access tokens", () => {
  assert.deepEqual(credentialOf({ type: "oauth", access: "token" }), {
    token: "token",
    oauth: true,
  })
})

test("accepts plain string credentials", () => {
  assert.deepEqual(credentialOf("raw"), { token: "raw", oauth: false })
})

test("reads legacy API key shapes", () => {
  assert.deepEqual(credentialOf({ apiKey: "legacy" }), { token: "legacy", oauth: false })
})

test("rejects missing or malformed credentials", () => {
  assert.equal(credentialOf(undefined), undefined)
  assert.equal(credentialOf({ type: "key" }), undefined)
  assert.equal(credentialOf({ type: "oauth" }), undefined)
  assert.equal(credentialOf({}), undefined)
})
