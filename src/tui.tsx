import { Plugin } from "@opencode/plugin/tui"
import type { HistoryEntry } from "./history.ts"
import { PLUGIN_ID, TUI_PLUGIN_ID } from "./ids.ts"
import { ModelSync } from "./rpc.ts"
import { formatHistory, formatSummary, type Summary } from "./summary.ts"

export default Plugin.define({
  id: TUI_PLUGIN_ID,
  setup(context) {
    const refresh = async (force: boolean) => {
      try {
        const result = (await context.client.rpc(ModelSync).refresh({ force })) as {
          providers: Summary[]
        }
        context.ui.toast.show({
          title: force ? "Model refresh (forced)" : "Model refresh",
          message: formatSummary(result.providers),
          duration: 8000,
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Model refresh failed",
          message: error instanceof Error ? error.message : String(error),
          duration: 8000,
        })
      }
    }

    const showHistory = async () => {
      try {
        const result = (await context.client.rpc(ModelSync).history({})) as {
          events: HistoryEntry[]
        }
        await context.ui.dialog.alert({
          title: "Model refresh history",
          message: formatHistory(result.events, 50),
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Model refresh history failed",
          message: error instanceof Error ? error.message : String(error),
          duration: 8000,
        })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: `${PLUGIN_ID}.refresh`,
          title: "Refresh models",
          group: "Models",
          palette: true,
          suggested: true,
          slash: { name: "refresh-models" },
          run: () => refresh(false),
        },
        {
          id: `${PLUGIN_ID}.refresh-force`,
          title: "Refresh models (force)",
          group: "Models",
          palette: true,
          slash: { name: "refresh-models-force" },
          run: () => refresh(true),
        },
        {
          id: `${PLUGIN_ID}.history`,
          title: "Show model refresh history",
          group: "Models",
          palette: true,
          slash: { name: "refresh-models-history" },
          run: () => showHistory(),
        },
      ],
    }))
  },
})
