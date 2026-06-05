import type { CommandModule } from "yargs"
import { collectRuntimeStatus, formatRuntimeStatus } from "@/codegoblin/runtime-status"
import { discoverLocalModels, formatLocalModels } from "@/codegoblin/local-models"

type Args = {
  json?: boolean
}

export const StatusCommand = {
  command: "status",
  describe: "show CodeGoblin runtime status (native sidecar, web UI source)",
  builder: (yargs) =>
    yargs.option("json", {
      describe: "output as JSON",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    const [status, localModels] = await Promise.all([collectRuntimeStatus(), discoverLocalModels()])
    if (args.json) {
      console.log(JSON.stringify({ ...status, localModels }, null, 2))
      return
    }
    console.log(`${formatRuntimeStatus(status)}\n${formatLocalModels(localModels)}`)
  },
} satisfies CommandModule<object, Args>
