import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startReconciler } from "../src/reconcile.ts"
import type { Adapter, ProviderConfig } from "../src/types.ts"

const adapter: Adapter = {
  normalize(entry) {
    return { id: entry.id, raw: entry }
  },
  classify(status) {
    if ([400, 403, 404, 410].includes(status)) return false
    return undefined
  },
}

interface FakeProviderModel {
  id: string
  modelID: string
  providerID: string
  name?: string
  limit?: { context?: number; output?: number }
  [key: string]: any
}

function fakeContext(options: {
  models: string[]
  catalogue?: any[]
  credential?: { active: boolean; value: any }
  apiKey?: string
  persisted?: any
  failGet?: boolean
  failSet?: boolean
}) {
  let models = new Map<string, FakeProviderModel>(
    options.models.map((id) => [id, { id, modelID: id, providerID: "test" }]),
  )
  const stored = new Map<string, any>()
  if (options.persisted) stored.set("state:test", options.persisted)
  let transform: ((editor: any) => void) | undefined

  const ctx = {
    app: { version: "test" },
    integration: {
      connection: {
        active: async () =>
          options.credential?.active ? { id: "connection" } : undefined,
        resolve: async () => (options.credential?.active ? options.credential.value : undefined),
      },
    },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        transform = callback
      },
      reload: async () => {
        if (!transform) return
        transform({
          get: (providerID: string) =>
            providerID === "test" ? { models: new Map(models) } : undefined,
          models: {
            set: (_providerID: string, next: FakeProviderModel[]) => {
              models = new Map(next.map((model) => [model.modelID ?? model.id, model]))
            },
          },
        })
      },
      get: async () => ({ settings: options.apiKey ? { apiKey: options.apiKey } : {} }),
    },
    model: {
      list: async () => [...models.values(), ...(options.catalogue ?? [])],
    },
    storage: {
      get: async (key: string) => {
        if (options.failGet) throw new Error("storage read failed")
        return stored.get(key)
      },
      set: async (key: string, value: any) => {
        if (options.failSet) throw new Error("storage write failed")
        stored.set(key, value)
      },
    },
  }

  return { ctx, stored, models: () => [...models.values()] }
}

function config(statusPath: string): ProviderConfig {
  return {
    adapterID: "test",
    providerID: "test",
    integrationID: "test",
    baseURL: "https://example.test/v1",
    reasoningField: "reasoning_content",
    refreshMinutes: 60,
  probeConcurrency: 5,
    storageKey: "state:test",
    statusPath,
  }
}

function stubFetch(live: string[], statuses: Record<string, number>) {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: live.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const body = init?.body ? JSON.parse(init.body) : {}
    return new Response("{}", { status: statuses[body.model] ?? 404 })
  }) as typeof fetch
  return {
    requests,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

async function withStatusPath<T>(fn: (statusPath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "model-refresh-"))
  try {
    return await fn(join(directory, "models.json"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("full cycle adds new models and records history", async () => {
  await withStatusPath(async (statusPath) => {
    const fetchStub = stubFetch(["a", "b"], { a: 200, b: 200 })
    const fake = fakeContext({
      models: ["a"],
      catalogue: [
        {
          id: "b",
          modelID: "b",
          providerID: "catalog",
          name: "Catalogue B",
          limit: { context: 4096, output: 512 },
        },
      ],
      credential: { active: true, value: { type: "key", key: "secret" } },
      persisted: { entries: [], probes: {}, offered: ["a"], history: [] },
    })
    const reconciler = await startReconciler(fake.ctx, adapter, config(statusPath))
    try {
      const result = await reconciler.refresh()
      assert.equal(result.error, undefined)
      assert.equal(result.offered, 2)
      const stored = fake.stored.get("state:test")
      assert.deepEqual(stored.offered, ["a", "b"])
      assert.deepEqual(stored.history[0].added, ["b"])
      assert.equal(stored.catalogue.b.name, "Catalogue B")
      assert.equal(fake.models().find((model) => model.modelID === "b")?.name, "Catalogue B")
      const timeline = await readFile(statusPath.replace(/models\.json$/, "changes.txt"), "utf8")
      assert.match(timeline, /\+ b/)
    } finally {
      reconciler.dispose()
      fetchStub.restore()
    }
  })
})

test("guard holds the last good inventory when every live probe is refused", async () => {
  await withStatusPath(async (statusPath) => {
    const fetchStub = stubFetch(["a"], { a: 403, b: 200 })
    const fake = fakeContext({
      models: ["a", "b"],
      credential: { active: true, value: { type: "key", key: "secret" } },
      persisted: { entries: [], probes: {}, offered: ["a", "b"], history: [] },
    })
    const reconciler = await startReconciler(fake.ctx, adapter, config(statusPath))
    try {
      const result = await reconciler.refresh()
      assert.equal(result.guarded, true)
      const stored = fake.stored.get("state:test")
      assert.deepEqual(stored.offered, ["a", "b"])
      assert.equal(stored.history[0].guarded, true)
      assert.deepEqual(
        fake.models().map((model) => model.modelID),
        ["a", "b"],
      )
    } finally {
      reconciler.dispose()
      fetchStub.restore()
    }
  })
})

test("missing credentials are recorded in history and status", async () => {
  await withStatusPath(async (statusPath) => {
    const fetchStub = stubFetch([], {})
    const fake = fakeContext({ models: [] })
    const reconciler = await startReconciler(fake.ctx, adapter, config(statusPath))
    try {
      const result = await reconciler.refresh()
      assert.match(result.error ?? "", /no credential/)
      const stored = fake.stored.get("state:test")
      assert.match(stored.history[0].error, /no credential/)
      const status = JSON.parse(await readFile(statusPath, "utf8"))
      assert.match(status.error, /no credential/)
      assert.equal(fetchStub.requests.length, 0)
    } finally {
      reconciler.dispose()
      fetchStub.restore()
    }
  })
})

test("storage failures do not abort the refresh", async () => {
  await withStatusPath(async (statusPath) => {
    const fetchStub = stubFetch(["a"], { a: 200 })
    const fake = fakeContext({
      models: ["a"],
      credential: { active: true, value: { type: "key", key: "secret" } },
      failGet: true,
      failSet: true,
    })
    const reconciler = await startReconciler(fake.ctx, adapter, config(statusPath))
    try {
      const result = await reconciler.refresh()
      assert.equal(result.error, undefined)
      assert.equal(result.provider, "test")
      const timeline = await readFile(statusPath.replace(/models\.json$/, "changes.txt"), "utf8")
      assert.match(timeline, /baseline inventory|\+ a/)
    } finally {
      reconciler.dispose()
      fetchStub.restore()
    }
  })
})
