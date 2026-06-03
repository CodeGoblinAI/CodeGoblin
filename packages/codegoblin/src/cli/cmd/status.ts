import type { CommandModule } from "yargs"
import { collectRuntimeStatus, formatRuntimeStatus } from "@/codegoblin/runtime-status"

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
    const status = await collectRuntimeStatus()
    if (args.json) {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    console.log(formatRuntimeStatus(status))
  },
} satisfies CommandModule<object, Args>
