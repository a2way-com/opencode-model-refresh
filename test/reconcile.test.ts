import test from "node:test"
import assert from "node:assert/strict"

import { isGuarded } from "../src/reconcile.ts"

test("wipe guard triggers when live probes are refused and none succeed", () => {
  assert.equal(isGuarded(1, 1, 0), true)
  assert.equal(isGuarded(3, 5, 0), true)
})

test("wipe guard does not trigger without refusals", () => {
  assert.equal(isGuarded(0, 1, 0), false)
})

test("wipe guard does not trigger without live attempts", () => {
  assert.equal(isGuarded(1, 0, 0), false)
})

test("wipe guard does not trigger when at least one live probe succeeds", () => {
  assert.equal(isGuarded(1, 1, 1), false)
  assert.equal(isGuarded(3, 5, 2), false)
})