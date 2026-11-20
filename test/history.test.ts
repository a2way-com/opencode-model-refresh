import test from "node:test"
import assert from "node:assert/strict"

import { buildHistoryLines, isStaleHistoryError } from "../src/history.ts"

test("renders added and removed models", () => {
  const lines = buildHistoryLines(
    [{ at: "t1", provider: "p", added: ["a"], removed: ["b"] }],
    new Set(),
    "now",
  )
  assert.deepEqual(lines, ["t1: +1 -1", "+ a", "- b"])
})

test("marks no-change cycles and appends the baseline inventory", () => {
  const lines = buildHistoryLines(
    [{ at: "t1", provider: "p", added: [], removed: [] }],
    new Set(["m1", "m2"]),
    "now",
  )
  assert.deepEqual(lines, [
    "t1: +0 -0 | no change",
    "now: baseline inventory",
    "+ m1",
    "+ m2",
  ])
})

test("labels guard and error entries", () => {
  const lines = buildHistoryLines(
    [
      { at: "t1", provider: "p", added: [], removed: [], guarded: true },
      { at: "t2", provider: "p", added: [], removed: [], error: "boom" },
    ],
    new Set(["m1"]),
    "now",
  )
  assert.deepEqual(lines, [
    "t1: +0 -0 | guard",
    "t2: +0 -0 | error: boom",
    "now: baseline inventory",
    "+ m1",
  ])
})

test("always writes at least one line", () => {
  assert.deepEqual(buildHistoryLines([], new Set(), "now"), ["No models recorded yet."])
})

test("recognizes stale development-build errors", () => {
  assert.equal(isStaleHistoryError("ReferenceError: isGuarded is not defined"), true)
  assert.equal(isStaleHistoryError("ReferenceError: headers is not defined"), true)
  assert.equal(
    isStaleHistoryError("TypeError: undefined is not an object (evaluating '[id, ok]')"),
    true,
  )
  assert.equal(isStaleHistoryError("no credential for opencode"), false)
  assert.equal(isStaleHistoryError(undefined), false)
})
