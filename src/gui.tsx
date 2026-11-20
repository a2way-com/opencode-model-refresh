import { Command, Plugin } from "@opencode/plugin/gui"
import type { HistoryEntry } from "./history.ts"
import { ModelSync } from "./rpc.ts"
import { formatHistory, formatSummary, type Summary } from "./summary.ts"

export default Plugin.define({
  setup(ctx) {
    const refresh = async (force: boolean) => {
      const pending = ctx.toast.show({
        variant: "loading",
        title: force ? "Refreshing models (forced)…" : "Refreshing models…",
        persistent: true,
      })
      try {
        const result = (await ctx.client.rpc(ModelSync).refresh({ force })) as {
          providers: Summary[]
        }
        const providers = result.providers
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

    const showHistory = async () => {
      try {
        const result = (await ctx.client.rpc(ModelSync).history({})) as {
          events: HistoryEntry[]
        }
        ctx.dialogs.open((dialog) => (
          <ctx.ui.Dialog
            title="Model refresh history"
            size="x-large"
            footer={<ctx.ui.Button onClick={dialog.close}>Close</ctx.ui.Button>}
          >
            <pre style={{ "white-space": "pre-wrap", "font-family": "monospace", margin: "0" }}>
              {formatHistory(result.events, 50)}
            </pre>
          </ctx.ui.Dialog>
        ))
      } catch (error) {
        ctx.toast.show({
          variant: "error",
          title: "Model refresh history failed",
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

    ctx.add(
      Command,
      (): Command => ({
        id: "history",
        title: "Show model refresh history",
        description: "Show recent model changes, guard events and errors",
        group: "Models",
        section: "model",
        slash: { name: "refresh-models-history" },
        run: () => showHistory(),
      }),
    )
  },
})