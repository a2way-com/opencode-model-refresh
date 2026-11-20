import { Plugin } from "@opencode/plugin"
import { nvidia } from "./adapters/nvidia"
import { opencode } from "./adapters/opencode"
import { resolveBinding } from "./binding.ts"
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
 * The provider definition. Its `integrationID` names the credential account
 * and, when no adapter exists under the provider ID, the adapter dialect.
 */
async function providerDefinition(ctx: any, providerID: string): Promise<any> {
  try {
    const result = await ctx.provider.get({ providerID })
    return result?.data ?? result
  } catch {
    // Not resolvable; the provider is skipped by the caller.
    return undefined
  }
}

/**
 * Endpoint from the provider definition itself, when it is a plain absolute
 * URL. Adapters never define endpoints, and neither do plugin options.
 */
function configuredBaseURL(provider: any): string | undefined {
  const baseURL = provider?.settings?.baseURL
  if (typeof baseURL === "string" && /^https?:\/\//i.test(baseURL) && !baseURL.includes("${")) {
    return baseURL
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

      const provider = await providerDefinition(ctx, providerID)
      const inferredIntegrationID =
        typeof provider?.integrationID === "string" ? provider.integrationID : undefined
      const { adapterID, integrationID } = resolveBinding({
        providerID,
        providerIntegrationID: inferredIntegrationID,
        adapter: entry.adapter,
        integrationID: entry.integrationID,
        adapters,
      })
      const adapter = adapters[adapterID]
      if (!adapter) {
        console.warn(
          `${PLUGIN_ID}: no adapter "${adapterID}" for provider "${providerID}"; skipping`,
        )
        continue
      }

      const baseURL = configuredBaseURL(provider)
      if (!baseURL) {
        console.warn(`${PLUGIN_ID}: no baseURL for provider "${providerID}"; skipping`)
        continue
      }
      const refreshMinutes = Number(
        entry.refreshMinutes ?? ctx.options.refreshMinutes ?? 60,
      )
      const probeConcurrency = Number(
        entry.probeConcurrency ?? ctx.options.probeConcurrency ?? 5,
      )
      const config: ProviderConfig = {
        adapterID,
        providerID,
        integrationID,
        baseURL: String(baseURL).replace(/\/+$/, ""),
        headers:
          provider?.headers && typeof provider.headers === "object" ? provider.headers : undefined,
        userAgent: `opencode/${ctx.app.version}`,
        reasoningField: entry.reasoningField ?? "reasoning_content",
        refreshMinutes:
          Number.isFinite(refreshMinutes) && refreshMinutes > 0 ? refreshMinutes : 60,
        probeConcurrency:
          Number.isFinite(probeConcurrency) && probeConcurrency > 0
            ? Math.trunc(probeConcurrency)
            : 5,
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
