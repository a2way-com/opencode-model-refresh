import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { writeFileSync } from "node:fs"
import { PLUGIN_ID } from "./ids.ts"
import { fetchModels, probe } from "./openai.ts"
import type { Adapter, NormalizedEntry, ProviderConfig } from "./types.ts"

const REFUSED_RETRY_MS = 7 * 24 * 60 * 60 * 1000
const UNLISTED_RECHECK_MS = 24 * 60 * 60 * 1000
const PROBE_CONCURRENCY = 5

export function isGuarded(refusedCount: number, liveAttempts: number, liveOK: number): boolean {
  return refusedCount > 0 && liveAttempts > 0 && liveOK === 0
}

const idsOf = (model) => [model.modelID ?? model.id, model.id]

function displayName(id: string) {
  return id
    .split("/")
    .pop()
    .split("-")
    .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function apiKeyOf(credential: any): string | undefined {
  if (!credential) return undefined
  if (typeof credential === "string") return credential
  if (typeof credential !== "object") return undefined
  for (const field of ["key", "apiKey", "token", "value", "secret"]) {
    if (typeof credential[field] === "string" && credential[field]) return credential[field]
  }
  return undefined
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let index = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index++
        results[current] = await fn(items[current])
      }
    }),
  )
  return results
}

function decorate(model: any, entry?: NormalizedEntry) {
  if (!entry) return model
  const next = { ...model }
  if (Number.isInteger(entry.contextWindow) && entry.contextWindow! > 0) {
    next.limit = { ...model.limit, context: entry.contextWindow }
  }
  if (Number.isInteger(entry.outputLimit) && entry.outputLimit! > 0) {
    next.limit = { ...next.limit, output: entry.outputLimit }
  }
  if (typeof entry.tools === "boolean") {
    next.capabilities = { ...next.capabilities, tools: entry.tools }
  }
  if (entry.vision) {
    next.capabilities = { ...next.capabilities, input: ["text", "image"] }
  }
  return next
}

function makeModel(entry: NormalizedEntry, template: any, config: ProviderConfig) {
  const context = entry.contextWindow && entry.contextWindow > 0 ? entry.contextWindow : 200000
  const output = entry.outputLimit && entry.outputLimit > 0 ? entry.outputLimit : Math.min(32768, context)
  return {
    id: entry.id,
    modelID: entry.id,
    providerID: config.providerID,
    type: "chat",
    family: entry.family ?? entry.id.split("/")[0],
    name: entry.name ?? displayName(entry.id),
    package: template?.package,
    settings: template?.settings,
    compatibility: {
      ...(template?.compatibility ?? {}),
      reasoningField: config.reasoningField,
    },
    capabilities: {
      tools: entry.tools ?? true,
      input: entry.vision ? ["text", "image"] : ["text"],
      output: ["text"],
      temperature: true,
    },
    variants: [],
    time: { released: (entry.created ?? 0) * 1000 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context, output },
  }
}

export interface RefreshSummary {
  provider: string
  offered?: number
  probed?: number
  ok?: number
  refused?: number
  guarded?: boolean
  error?: string
}

/**
 * Start one independent reconciliation loop. All provider-specific behavior is
 * supplied by the adapter; this function owns probing, verdict caching,
 * inventory rebuilding, persistence and scheduling.
 */
export async function startReconciler(ctx: any, adapter: Adapter, config: ProviderConfig) {
  const writeStatus = async (status: any) => {
    try {
      await mkdir(dirname(config.statusPath), { recursive: true })
      await writeFile(config.statusPath, `${JSON.stringify(status, null, 2)}\n`)
    } catch {
      // Status reporting must never affect reconciliation.
    }
  }

  const historyPath = `${dirname(config.statusPath)}/changes.txt`
  const writeHistory = () => {
    try {
      const lines: string[] = []
      for (const entry of state.history as any[]) {
        const summary = [`${entry.at}: +${entry.added.length} -${entry.removed.length}`]
        if (entry.guarded) summary.push("guard")
        if (entry.error) summary.push(`error: ${entry.error}`)
        lines.push(summary.join(" | "))
        for (const id of entry.added) lines.push(`+ ${id}`)
        for (const id of entry.removed) lines.push(`- ${id}`)
      }
      writeFileSync(historyPath, `${lines.join("\n")}\n`)
    } catch {
      // History reporting must never affect reconciliation.
    }
  }

  const resolveApiKey = async (): Promise<string | undefined> => {
    try {
      const connection = await ctx.integration.connection.active(config.integrationID)
      if (connection) {
        const key = apiKeyOf(await ctx.integration.connection.resolve(connection))
        if (key) return key
      }
    } catch {
      // Fall through to provider settings.
    }
    try {
      const result = await ctx.provider.get({ providerID: config.providerID })
      const provider = result?.data ?? result
      return provider?.settings?.apiKey
    } catch {
      return undefined
    }
  }

  const persisted = await ctx.storage.get(config.storageKey)
  const persistedEntries = Array.isArray(persisted?.entries) ? persisted.entries : []
  const normalized = new Map<string, NormalizedEntry>()
  for (const entry of persistedEntries) {
    if (typeof entry?.id === "string") normalized.set(entry.id, adapter.normalize(entry))
  }
  const sameHistory = (a: any, b: any) =>
    a?.provider === b?.provider &&
    JSON.stringify(a?.added ?? []) === JSON.stringify(b?.added ?? []) &&
    JSON.stringify(a?.removed ?? []) === JSON.stringify(b?.removed ?? []) &&
    Boolean(a?.guarded) === Boolean(b?.guarded) &&
    (a?.error ?? undefined) === (b?.error ?? undefined)
  const rawHistory = Array.isArray(persisted?.history) ? persisted.history : []
  const history: any[] = []
  for (const entry of rawHistory) {
    if (history.some((existing) => sameHistory(existing, entry))) continue
    history.push(entry)
  }
  const state = {
    apiKey: undefined as string | undefined,
    entries: persistedEntries,
    normalized,
    probes: persisted?.probes ?? {},
    lastGood: new Set<string>(Array.isArray(persisted?.offered) ? persisted.offered : []),
    offered: new Set<string>(Array.isArray(persisted?.offered) ? persisted.offered : []),
    history,
    /**
     * Cached verdicts are trustworthy until their retry window elapses, so the
     * picker can be filtered immediately instead of exposing the raw catalogue
     * while the first network cycle runs.
     */
    ready: Boolean(persisted),
    guarded: false,
  }
  const verdictOf = (id: string) => state.probes[id]?.ok

  await ctx.provider.transform((editor) => {
    if (!state.ready) return
    const record = editor.get(config.providerID)
    if (!record) return

    const existing = [...record.models.values()]

    /**
     * On a guarded cycle, keep exactly the last successfully reconciled
     * inventory. Returning early would expose the provider's raw catalogue,
     * which can include models that earlier cycles removed as refused.
     */
    if (state.guarded) {
      if (state.lastGood.size === 0) return
      const restored = existing
        .filter((model) => state.lastGood.has(model.modelID ?? model.id))
        .map((model) => decorate(model, state.normalized.get(model.modelID ?? model.id)))
      if (restored.length === existing.length) return
      editor.models.set(config.providerID, restored)
      console.log(
        `${PLUGIN_ID}[${config.providerID}]: guard held last-known inventory ` +
          `(${restored.length} model(s))`,
      )
      return
    }

    const template = existing[0]
    const kept: any[] = []
    const seen = new Set<string>()

    for (const model of existing) {
      const id = model.modelID ?? model.id
      if (seen.has(id)) continue
      /**
       * Only a definite refusal removes a model. Unlisted, unprobed or
       * inconclusive entries are never punished for a timeout or an API quirk.
       */
      if (verdictOf(id) === false) continue
      seen.add(id)
      kept.push(decorate(model, state.normalized.get(id)))
    }

    /**
     * Rate-limited models are not proven invocable, but dropping them from the
     * picker is unfair: a 429 can be transient. Keep listed models that are
     * rate-limited unless they have a definite refusal.
     */
    const additions = [...state.normalized.values()]
      .filter((entry) => verdictOf(entry.id) === true || state.probes[entry.id]?.rateLimited === true)
      .filter((entry) => !seen.has(entry.id))
      .map((entry) => makeModel(entry, template, config))

    if (kept.length === existing.length && additions.length === 0) return
    editor.models.set(config.providerID, [...kept, ...additions])
    console.log(
      `${PLUGIN_ID}[${config.providerID}]: ${kept.length + additions.length} model(s) offered ` +
        `(removed ${existing.length - kept.length}, added ${additions.length})`,
    )
  })

  let running: Promise<RefreshSummary> | undefined
  const run = async (force: boolean): Promise<RefreshSummary> => {
    const report: any = { at: new Date().toISOString(), provider: config.providerID, probed: {} }
    try {
      state.apiKey = (await resolveApiKey()) ?? state.apiKey
      if (!state.apiKey) {
        const error = `no credential for ${config.integrationID}`
        await writeStatus({ ...report, error })
        return { provider: config.providerID, error }
      }

      const entries = await fetchModels(config, state.apiKey)
      const live = new Set(entries.map((entry) => entry.id))

      const listed = await ctx.model.list()
      const activeModels = Array.isArray(listed) ? listed : (listed?.data ?? listed?.models ?? [])
      const active = activeModels
        .filter((model) => model.providerID === config.providerID)
        .flatMap(idsOf)
      const previousOffered = new Set(state.offered)
      state.offered = new Set([...state.offered, ...active])

      /**
       * Adapters may narrow the probe pool, e.g. to a free tier. Offered models
       * are always included so withdrawn entries can be detected and removed.
       */
      const selected = adapter.select ? adapter.select(entries, state.offered) : entries
      const candidatePool = new Set([...selected.map((entry) => entry.id), ...state.offered])
      const candidates = force
        ? [...candidatePool]
        : [...candidatePool].filter((id) => {
            const verdict = state.probes[id]
            if (!verdict) return true
            if (!verdict.ok) return Date.now() - verdict.at > REFUSED_RETRY_MS
            return !live.has(id) && Date.now() - verdict.at > UNLISTED_RECHECK_MS
          })

      const rateLimited = new Set<string>()
      const verdicts = await mapLimit(candidates, PROBE_CONCURRENCY, async (id) => [
        id,
        await probe(config, adapter, state.apiKey!, id, rateLimited),
      ] as const)

      let okCount = 0
      let refusedCount = 0
      let liveAttempts = 0
      let liveOK = 0
      for (const [id, ok] of verdicts) {
        report.probed[id] =
          ok === undefined
            ? rateLimited.has(id)
              ? "rate-limited"
              : "inconclusive"
            : ok
              ? "ok"
              : "unavailable"
        if (live.has(id)) {
          liveAttempts++
          if (ok === true) liveOK++
        }
        if (ok === true) okCount++
        if (ok === false) refusedCount++
        if (ok === undefined) {
          /**
           * A 429 is an inconclusive probe, but remember it so the model can be
           * kept in the picker instead of being dropped as unproven.
           */
          if (rateLimited.has(id)) {
            state.probes[id] = { ...(state.probes[id] ?? {}), rateLimited: true, at: Date.now() }
          }
          continue // retry next cycle; change nothing
        }
        state.probes[id] = { ok, at: Date.now(), rateLimited: rateLimited.has(id) }
      }

      /**
       * A cycle where live models are refused and none succeeds looks like a
       * dialect/authentication failure, not a provider deleting its catalogue.
       * Skip that rebuild. A cycle limited to unlisted models is allowed: that
       * is how genuinely withdrawn models are removed.
       */
      state.guarded = isGuarded(refusedCount, liveAttempts, liveOK)
      state.entries = entries
      state.normalized = new Map(entries.map((entry) => [entry.id, adapter.normalize(entry)]))
      state.ready = true

      await ctx.provider.reload()
      const finalResponse = await ctx.model.list()
      const finalModels = Array.isArray(finalResponse)
        ? finalResponse
        : (finalResponse?.data ?? finalResponse?.models ?? [])
      const offered = finalModels
        .filter((model) => model.providerID === config.providerID)
        .map((model) => model.modelID ?? model.id)
      const added = offered.filter((id) => !previousOffered.has(id))
      const removed = [...previousOffered].filter((id) => !offered.includes(id))
      const isDuplicate = state.history.some(
        (entry: any) =>
          entry?.provider === config.providerID &&
          JSON.stringify(entry?.added ?? []) === JSON.stringify(added) &&
          JSON.stringify(entry?.removed ?? []) === JSON.stringify(removed) &&
          Boolean(entry?.guarded) === state.guarded &&
          (entry?.error ?? undefined) === undefined,
      )
      if ((added.length || removed.length || state.guarded) && !isDuplicate) {
        state.history.unshift({
          at: new Date().toISOString(),
          provider: config.providerID,
          added,
          removed,
          guarded: state.guarded,
        })
        if (state.history.length > 50) state.history.length = 50
      }
      if (!state.guarded) state.lastGood = new Set(offered)
      await ctx.storage.set(config.storageKey, {
        entries: state.entries,
        probes: state.probes,
        offered: [...state.lastGood],
        history: state.history,
      })
      writeHistory()

      await writeStatus({
        ...report,
        adapter: config.adapterID,
        baseURL: config.baseURL,
        live: live.size,
        candidates: candidates.length,
        ok: okCount,
        refused: refusedCount,
        guarded: state.guarded,
        offered,
        refusedModels: Object.entries(state.probes)
          .filter(([, verdict]: any) => verdict.ok === false)
          .map(([id]) => id),
        ...(state.guarded
          ? { warning: "every live probe failed; inventory left unchanged (possible dialect or auth mismatch)" }
          : {}),
      })

      return {
        provider: config.providerID,
        offered: offered.length,
        probed: candidates.length,
        ok: okCount,
        refused: refusedCount,
        guarded: state.guarded,
      }
    } catch (error) {
      console.warn(`${PLUGIN_ID}[${config.providerID}]: refresh failed: ${error}`)
      state.history.unshift({
        at: new Date().toISOString(),
        provider: config.providerID,
        added: [],
        removed: [],
        error: String(error),
      })
      if (state.history.length > 50) state.history.length = 50
      await ctx.storage.set(config.storageKey, {
        entries: state.entries,
        probes: state.probes,
        offered: [...state.lastGood],
        history: state.history,
      })
      writeHistory()
      await writeStatus({ ...report, error: String(error) })
      return { provider: config.providerID, error: String(error) }
    }
  }

  const refresh = (force = false): Promise<RefreshSummary> => {
    /**
     * A manual refresh during a cycle joins it instead of starting another.
     * A forced request that arrives mid-cycle runs once more afterwards.
     */
    if (running) return force ? running.then(() => refresh(true)) : running
    running = run(force).finally(() => {
      running = undefined
    })
    return running
  }

  void refresh()
  const timer = setInterval(() => void refresh(), config.refreshMinutes * 60 * 1000)
  timer.unref?.()
  return { refresh, history: () => state.history, dispose: () => clearInterval(timer) }
}
