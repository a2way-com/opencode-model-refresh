import test from "node:test"
import assert from "node:assert/strict"

import {
  RATE_LIMITED_BACKOFF_MS,
  REFUSED_RETRY_MS,
  UNLISTED_RECHECK_MS,
  selectCandidateIDs,
} from "../src/selection.ts"

const now = 1_000_000_000_000
const never = new Set<string>()

test("probes candidates without a cached verdict", () => {
  assert.deepEqual(selectCandidateIDs(["a", "b"], {}, never, now), ["a", "b"])
})

test("definite refusals wait for the retry window", () => {
  const fresh = { a: { ok: false, at: now } }
  const due = { a: { ok: false, at: now - REFUSED_RETRY_MS - 1 } }
  assert.deepEqual(selectCandidateIDs(["a"], fresh, never, now), [])
  assert.deepEqual(selectCandidateIDs(["a"], due, never, now), ["a"])
})

test("unlisted successes wait for the recheck window", () => {
  const recent = { a: { ok: true, at: now } }
  const stale = { a: { ok: true, at: now - UNLISTED_RECHECK_MS - 1 } }
  assert.deepEqual(selectCandidateIDs(["a"], recent, never, now), [])
  assert.deepEqual(selectCandidateIDs(["a"], stale, never, now), ["a"])
  assert.deepEqual(selectCandidateIDs(["a"], stale, new Set(["a"]), now), [])
})

test("rate-limited models back off briefly without becoming refusals", () => {
  const recent = { a: { at: now, rateLimited: true } }
  const due = { a: { at: now - RATE_LIMITED_BACKOFF_MS - 1, rateLimited: true } }
  assert.deepEqual(selectCandidateIDs(["a"], recent, never, now), [])
  assert.deepEqual(selectCandidateIDs(["a"], due, never, now), ["a"])
})

test("rate-limited models honor a provider retry time", () => {
  const waiting = { a: { at: now, rateLimited: true, retryAt: now + 60_000 } }
  const due = { a: { at: now, rateLimited: true, retryAt: now - 1 } }
  assert.deepEqual(selectCandidateIDs(["a"], waiting, never, now), [])
  assert.deepEqual(selectCandidateIDs(["a"], due, never, now), ["a"])
})

test("a recent rate limit takes precedence over an older success", () => {
  const waiting = {
    a: { ok: true, at: now, rateLimited: true, retryAt: now + 60_000 },
  }
  const due = { a: { ok: true, at: now, rateLimited: true, retryAt: now - 1 } }
  assert.deepEqual(selectCandidateIDs(["a"], waiting, new Set(["a"]), now), [])
  assert.deepEqual(selectCandidateIDs(["a"], due, new Set(["a"]), now), ["a"])
})

test("other inconclusive results retry on the next cycle", () => {
  assert.deepEqual(selectCandidateIDs(["a"], { a: { at: now } }, never, now), ["a"])
})
