import test from "node:test"
import assert from "node:assert/strict"

import { formatHistory } from "../src/summary.ts"

test("formats an empty history", () => {
  assert.equal(formatHistory([]), "No refresh history yet.")
})

test("formats changes, no-change cycles and errors", () => {
  const text = formatHistory([
    { at: "t1", provider: "p1", added: ["a"], removed: ["b"] },
    { at: "t2", provider: "p2", added: [], removed: [] },
    { at: "t3", provider: "p3", added: [], removed: [], guarded: true },
    { at: "t4", provider: "p4", added: [], removed: [], error: "boom" },
  ])
  assert.equal(
    text,
    [
      "t1 p1: +1 -1",
      "+ a",
      "- b",
      "t2 p2: +0 -0 | no change",
      "t3 p3: +0 -0 | guard",
      "t4 p4: +0 -0 | error: boom",
    ].join("\n"),
  )
})

test("limits older events", () => {
  const events = Array.from({ length: 12 }, (_, index) => ({
    at: `t${index}`,
    provider: "p",
    added: [],
    removed: [],
  }))
  const text = formatHistory(events, 10)
  assert.match(text, /t9 p: \+0 -0 \| no change/)
  assert.doesNotMatch(text, /t10 p:/)
  assert.match(text, /… 2 older event\(s\)/)
})
