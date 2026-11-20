import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { credentialOf, type ResolvedCredential } from "./credentials.ts"
import { buildHistoryLines, isStaleHistoryError } from "./history.ts"
import { PLUGIN_ID } from "./ids.ts"
import { fetchModels, probe } from "./openai.ts"
import { selectCandidateIDs } from "./selection.ts"
import type { Adapter, NormalizedEntry, ProviderConfig } from "./types.ts"

const MAX_CATALOGUE_ENTRIES = 5000

export function isGuarded(refusedCount: number, liveAttempts: number, liveOK: number): boolean {
  return refusedCount > 0 && liveAttempts > 0 && liveOK === 0
}

const idsOf = (model: any) => [model.modelID ?? model.id, model.id]

function displayName(id: string) {
  return (id.split("/").pop() ?? id)
    .split("-")
    .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  /**
   * A missing, zero or non-numeric limit must not leave the results array
   * partially filled: callers destructure every entry.
   */
  const workers = Math.max(
    1,
    Math.min(Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 1, items.length),
  )
  const results = new Array<R>(items.length)
  let index = 0
  await Promise.all(
    Array.from({ length: workers }, async () => {
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

export function makeModel(
  entry: NormalizedEntry,
  template: any,
  config: ProviderConfig,
  catalog?: any,
) {
  const catalogContext =
    Number.isInteger(catalog?.limit?.context) && catalog.limit.context > 0
      ? catalog.limit.context
      : undefined
  const catalogOutput =
    Number.isInteger(catalog?.limit?.output) && catalog.limit.output > 0
      ? catalog.limit.output
      : undefined
  const context =
    entry.contextWindow && entry.contextWindow > 0
      ? entry.contextWindow
      : (catalogContext ?? 200000)
  const output =
    entry.outputLimit && entry.outputLimit > 0
      ? entry.outputLimit
      : (catalogOutput ?? Math.min(32768, context))
  const capabilities = catalog?.capabilities ?? {}
  return {
    ...(catalog ?? {}),
    id: entry.id,
    modelID: entry.id,
    providerID: config.providerID,
    type: "chat",
    family: entry.family ?? catalog?.family ?? entry.id.split("/")[0],
    name: entry.name ?? catalog?.name ?? displayName(entry.id),
    package: template?.package ?? catalog?.package,
    settings: template?.settings ?? catalog?.settings,
    compatibility: {
      ...(catalog?.compatibility ?? {}),
      ...(template?.compatibility ?? {}),
      reasoningField: config.reasoningField,
    },
    capabilities: {
      ...capabilities,
      tools: entry.tools ?? capabilities.tools ?? true,
      input:
        entry.vision === true
          ? ["text", "image"]
          : entry.vision === false
            ? ["text"]
            : (capabilities.input ?? ["text"]),
      output: capabilities.output ?? ["text"],
      temperature: capabilities.temperature ?? true,
    },
    variants: catalog?.variants ?? [],
    time: entry.created ? { released: entry.created * 1000 } : (catalog?.time ?? { released: 0 }),
    cost: catalog?.cost ?? [],
    status: catalog?.status ?? "active",
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
      mkdirSync(dirname(historyPath), { recursive: true })
      const lines = buildHistoryLines(state.history, state.lastGood)
      writeFileSync(historyPath, `${lines.join("\n")}\n`)
    } catch {
      // History reporting must never affect reconciliation.
    }
  }

  const resolveCredential = async (): Promise<ResolvedCredential | undefined> => {
    try {
      const connection = await ctx.integration.connection.active(config.integrationID)
      if (connection) {
        const credential = credentialOf(await ctx.integration.connection.resolve(connection))
        if (credential) return credential
      }
    } catch {
      // Fall through to provider settings.
    }
    try {
      const result = await ctx.provider.get({ providerID: config.providerID })
      const provider = result?.data ?? result
      const apiKey = provider?.settings?.apiKey
      return typeof apiKey === "string" && apiKey ? { token: apiKey, oauth: false } : undefined
    } catch {
      return undefined
    }
  }

  let persisted: any
  try {
    persisted = await ctx.storage.get(config.storageKey)
  } catch (error) {
    console.warn(`${PLUGIN_ID}[${config.providerID}]: storage read failed: ${error}`)
  }
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
    /**
     * Drop errors produced by partially reloaded development builds so they
     * never resurface in the timeline.
     */
    if (isStaleHistoryError(entry?.error)) continue
    if (history.some((existing) => sameHistory(existing, entry))) continue
    history.push(entry)
  }
  const state = {
    token: undefined as string | undefined,
    oauth: false,
    entries: persistedEntries,
    normalized,
    catalogue: new Map<string, any>(
      persisted?.catalogue && typeof persisted.catalogue === "object" && !Array.isArray(persisted.catalogue)
        ? Object.entries(persisted.catalogue)
        : [],
    ),
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
  const recordHistory = (entry: any) => {
    if (isStaleHistoryError(entry?.error)) return
    if (state.history.some((existing: any) => sameHistory(existing, entry))) return
    state.history.unshift(entry)
    if (state.history.length > 50) state.history.length = 50
  }
  const persist = async () => {
    try {
      await ctx.storage.set(config.storageKey, {
        entries: state.entries,
        probes: state.probes,
        catalogue: Object.fromEntries(state.catalogue),
        offered: [...state.lastGood],
        history: state.history,
      })
    } catch (error) {
      console.warn(`${PLUGIN_ID}[${config.providerID}]: storage write failed: ${error}`)
    }
  }
  /**
   * Ensure the change timeline file exists even before the first refresh, so
   * observers and tooling can rely on its presence.
   */
  writeHistory()
  const verdictOf = (id: string) => state.probes[id]?.ok

  await ctx.provider.transform((editor: any) => {
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
        .filter((model: any) => state.lastGood.has(model.modelID ?? model.id))
        .map((model: any) => decorate(model, state.normalized.get(model.modelID ?? model.id)))
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
      .filter((entry: any) => verdictOf(entry.id) === true || state.probes[entry.id]?.rateLimited === true)
      .filter((entry: any) => !seen.has(entry.id))
      .map((entry: any) => makeModel(entry, template, config, state.catalogue.get(entry.id)))

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
      const resolved =
        (await resolveCredential()) ??
        (state.token ? { token: state.token, oauth: state.oauth } : undefined)
      if (!resolved) {
        const error = `no credential for ${config.integrationID}`
        recordHistory({
          at: new Date().toISOString(),
          provider: config.providerID,
          added: [],
          removed: [],
          error,
        })
        await persist()
        writeHistory()
        await writeStatus({ ...report, error })
        return { provider: config.providerID, error }
      }
      state.token = resolved.token
      state.oauth = resolved.oauth

      const entries = await fetchModels(config, state.token)
      const live = new Set<string>(entries.map((entry: any) => entry.id))

      const listed = await ctx.model.list()
      const activeModels = Array.isArray(listed) ? listed : (listed?.data ?? listed?.models ?? [])
      const catalogue = new Map<string, any>()
      /**
       * Prefer this provider's own catalogue entries; fall back to another
       * provider only when the same model ID is not available locally.
       */
      for (const model of activeModels) {
        if (model.providerID !== config.providerID) continue
        const id = model.modelID ?? model.id
        if (typeof id === "string" && !catalogue.has(id)) catalogue.set(id, model)
      }
      for (const model of activeModels) {
        const id = model.modelID ?? model.id
        if (typeof id === "string" && !catalogue.has(id)) catalogue.set(id, model)
      }
      /**
       * Merge the current catalogue into the persisted snapshot. Removed models
       * keep their metadata for a future rediscovery. Same-provider entries win.
       */
      for (const [id, model] of catalogue) {
        const existing = state.catalogue.get(id)
        if (!existing || model.providerID === config.providerID) state.catalogue.set(id, model)
      }
      while (state.catalogue.size > MAX_CATALOGUE_ENTRIES) {
        const oldest = state.catalogue.keys().next().value
        if (oldest === undefined) break
        state.catalogue.delete(oldest)
      }
      const active = activeModels
        .filter((model: any) => model.providerID === config.providerID)
        .flatMap(idsOf)
      const previousOffered = new Set(state.offered)
      state.offered = new Set([...state.offered, ...active])

      /**
       * Drop cached verdicts for models that are neither listed nor offered.
       * They can no longer be reached by the candidate pool and would otherwise
       * accumulate forever.
       */
      for (const id of Object.keys(state.probes)) {
        if (!live.has(id) && !state.offered.has(id)) delete state.probes[id]
      }

      /**
       * Adapters may narrow the probe pool, e.g. to a free tier. Offered models
       * are always included so withdrawn entries can be detected and removed.
       */
      const selected = adapter.select ? adapter.select(entries, state.offered) : entries
      const candidatePool = new Set([...selected.map((entry: any) => entry.id), ...state.offered])
      const candidates = force
        ? [...candidatePool]
        : selectCandidateIDs(candidatePool, state.probes, live)

      const rateLimited = new Map<string, number>()
      const verdicts = await mapLimit(candidates, config.probeConcurrency, async (id) => [
        id,
        await probe(config, adapter, state.token!, id, rateLimited, state.oauth),
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
            state.probes[id] = {
              ...(state.probes[id] ?? {}),
              rateLimited: true,
              retryAt: rateLimited.get(id),
              at: Date.now(),
            }
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
      state.guarded = refusedCount > 0 && liveAttempts > 0 && liveOK === 0
      state.entries = entries
      state.normalized = new Map(entries.map((entry: any) => [entry.id, adapter.normalize(entry)]))
      state.ready = true

      await ctx.provider.reload()
      const finalResponse = await ctx.model.list()
      const finalModels = Array.isArray(finalResponse)
        ? finalResponse
        : (finalResponse?.data ?? finalResponse?.models ?? [])
      const offered = finalModels
        .filter((model: any) => model.providerID === config.providerID)
        .map((model: any) => model.modelID ?? model.id)
      const added = offered.filter((id: string) => !previousOffered.has(id))
      const removed = [...previousOffered].filter((id: string) => !offered.includes(id))
      state.offered = new Set(offered)
      recordHistory({
        at: new Date().toISOString(),
        provider: config.providerID,
        added,
        removed,
        guarded: state.guarded,
      })
      if (!state.guarded) state.lastGood = new Set(offered)
      await persist()
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
      recordHistory({
        at: new Date().toISOString(),
        provider: config.providerID,
        added: [],
        removed: [],
        error: String(error),
      })
      await persist()
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
