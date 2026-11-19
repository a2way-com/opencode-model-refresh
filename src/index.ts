import { Plugin } from "@opencode/plugin"
import { nvidia } from "./adapters/nvidia"
import { opencode } from "./adapters/opencode"
import { PLUGIN_ID } from "./ids.ts"
import { startReconciler } from "./reconcile.ts"
import type { RefreshSummary } from "./reconcile.ts"
import { ModelSync } from "./rpc.ts"
import type { Adapter, ProviderConfig } from "./types.ts"

const adapters: Record<string, Adapter> = {
  nvidia,
  opencode,
}

/**
 * Endpoint from the provider definition itself, when it is a plain absolute
 * URL. Adapters never define endpoints, and neither do plugin options.
 */
async function configuredBaseURL(ctx: any, providerID: string): Promise<string | undefined> {
  try {
    const result = await ctx.provider.get({ providerID })
    const provider = result?.data ?? result
    const baseURL = provider?.settings?.baseURL
    if (typeof baseURL === "string" && /^https?:\/\//i.test(baseURL) && !baseURL.includes("${")) {
      return baseURL
    }
  } catch {
    // Not resolvable; the provider is skipped by the caller.
  }
  return undefined
}

/**
 * Reconcile any number of providers in one plugin instance. Each provider gets
 * its own adapter, credential, verdict cache, status file and refresh timer.
 */
export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    /**
     * Double opt-in: the plugin does nothing unless providers are explicitly
     * configured. It never assumes a provider or its credentials.
     */
    const requested =
      Array.isArray(ctx.options.providers) && ctx.options.providers.length > 0
        ? ctx.options.providers
        : []

    const cleanups: Array<() => void> = []
    const refreshers: Array<{
      providerID: string
      refresh: (force?: boolean) => Promise<RefreshSummary>
      history: () => Array<{
        at: string
        provider: string
        added: string[]
        removed: string[]
        guarded?: boolean
        error?: string
      }>
    }> = []
    const seen = new Set<string>()
    for (const item of requested) {
      /**
       * Strings name OpenCode providers. Objects name a provider and, when the
       * dialect is not that provider's default, the adapter to use.
       */
      const entry = typeof item === "string" ? { provider: item } : item
      const providerID = entry.provider
      if (!providerID) {
        console.warn(`${PLUGIN_ID}: provider entry has no provider ID; skipping`)
        continue
      }
      if (seen.has(providerID)) {
        console.warn(`${PLUGIN_ID}: duplicate provider "${providerID}"; skipping`)
        continue
      }
      seen.add(providerID)

      /**
       * The registry key is the adapter ID. An entry may override it to reuse
       * a dialect under another provider.
       */
      const adapterID = entry.adapter ?? providerID
      const adapter = adapters[adapterID]
      if (!adapter) {
        console.warn(
          `${PLUGIN_ID}: no adapter "${adapterID}" for provider "${providerID}"; skipping`,
        )
        continue
      }

      const baseURL = await configuredBaseURL(ctx, providerID)
      if (!baseURL) {
        console.warn(`${PLUGIN_ID}: no baseURL for provider "${providerID}"; skipping`)
        continue
      }
      const config: ProviderConfig = {
        adapterID,
        providerID,
        integrationID: entry.integrationID ?? providerID,
        baseURL: String(baseURL).replace(/\/+$/, ""),
        userAgent: `opencode/${ctx.app.version}`,
        reasoningField: entry.reasoningField ?? "reasoning_content",
        refreshMinutes: Number(entry.refreshMinutes ?? ctx.options.refreshMinutes ?? 60),
        storageKey: `state:${providerID}`,
        statusPath:
          entry.statusPath ??
          `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/opencode/com.a2way.opencode-model-refresh/${providerID}/models.json`,
      }
      const reconciler = await startReconciler(ctx, adapter, config)
      refreshers.push({ providerID, refresh: reconciler.refresh, history: reconciler.history })
      cleanups.push(reconciler.dispose)
    }

    /**
     * Expose the same cycle over RPC so the TUI command can run it without
     * creating a session message or waking a model.
     */
    const rpc = await ctx.rpc.register(ModelSync, {
      refresh: async (input) => {
        const force = (input as { force?: boolean } | undefined)?.force === true
        const providers = await Promise.all(refreshers.map((item) => item.refresh(force)))
        return { providers }
      },
      history: async () => ({
        events: refreshers
          .flatMap((item) => item.history())
          .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
      }),
    })
    cleanups.push(() => {
      void rpc.dispose()
    })

    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  },
})
