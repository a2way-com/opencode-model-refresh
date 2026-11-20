import test from "node:test"
import assert from "node:assert/strict"

import { mapLimit } from "../src/reconcile.ts"

test("maps every item with a normal limit", async () => {
  assert.deepEqual(await mapLimit([1, 2, 3], 2, async (item) => item * 2), [2, 4, 6])
})

test("handles invalid limits without leaving holes", async () => {
  assert.deepEqual(await mapLimit([1, 2, 3], 0, async (item) => item * 2), [2, 4, 6])
  assert.deepEqual(await mapLimit([1, 2, 3], Number.NaN, async (item) => item * 2), [2, 4, 6])
})

test("returns an empty array for no items", async () => {
  assert.deepEqual(await mapLimit([], 5, async () => 1), [])
})
