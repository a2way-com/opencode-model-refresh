import { Plugin } from "@opencode/plugin/tui"
import { PLUGIN_ID, TUI_PLUGIN_ID } from "./ids.ts"
import { ModelSync } from "./rpc.ts"
import { formatSummary, type Summary } from "./summary.ts"

export default Plugin.define({
  id: TUI_PLUGIN_ID,
  setup(context) {
    const refresh = async (force: boolean) => {
      try {
        const result = await context.client.rpc(ModelSync).refresh({ force })
        context.ui.toast.show({
          title: force ? "Model refresh (forced)" : "Model refresh",
          message: formatSummary(result.providers as Summary[]),
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
      ],
    }))
  },
})
