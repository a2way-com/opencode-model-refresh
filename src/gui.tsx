import { Command, Plugin } from "@opencode/plugin/gui"
import { ModelSync } from "./rpc.ts"
import { formatSummary, type Summary } from "./summary.ts"

export default Plugin.define({
  setup(ctx) {
    const refresh = async (force: boolean) => {
      const pending = ctx.toast.show({
        variant: "loading",
        title: force ? "Refreshing models (forced)…" : "Refreshing models…",
        persistent: true,
      })
      try {
        const result = await ctx.client.rpc(ModelSync).refresh({ force })
        const providers = result.providers as Summary[]
        pending.dismiss()
        ctx.toast.show({
          variant: providers.some((item) => item.error || item.guarded) ? "default" : "success",
          title: force ? "Model refresh (forced)" : "Model refresh",
          description: formatSummary(providers),
          duration: 8000,
        })
      } catch (error) {
        pending.dismiss()
        ctx.toast.show({
          variant: "error",
          title: "Model refresh failed",
          description: error instanceof Error ? error.message : String(error),
          duration: 8000,
        })
      }
    }

    ctx.add(
      Command,
      (): Command => ({
        // Local id; the host publishes it as `com.a2way.opencode-model-refresh.refresh`.
        id: "refresh",
        title: "Refresh models",
        description: "Reconcile model pickers with live provider APIs",
        group: "Models",
        section: "model",
        suggested: true,
        featured: true,
        slash: { name: "refresh-models" },
        run: () => refresh(false),
      }),
    )

    ctx.add(
      Command,
      (): Command => ({
        id: "refresh-force",
        title: "Refresh models (force)",
        description: "Re-probe every candidate and reapply the wipe guard",
        group: "Models",
        section: "model",
        slash: { name: "refresh-models-force" },
        run: () => refresh(true),
      }),
    )
  },
})