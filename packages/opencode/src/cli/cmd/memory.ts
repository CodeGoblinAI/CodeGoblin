import type { Argv } from "yargs"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { CodeGoblinMemory, type CodeGoblinMemoryScope } from "@/codegoblin/memory"
import { errorMessage } from "../../util/error"

const SCOPES = ["user", "project", "session"] as const

const ListCommand = cmd({
  command: "list",
  describe: "list stored memory entries",
  builder: (yargs: Argv) =>
    yargs
      .option("scope", {
        describe: "only show entries in this scope",
        type: "string",
        choices: SCOPES as unknown as string[],
      })
      .option("project", {
        describe: "only show entries for this project id",
        type: "string",
      })
      .option("all", {
        describe: "include archived entries",
        type: "boolean",
        default: false,
      })
      .option("json", {
        describe: "output as JSON",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    try {
      const entries = CodeGoblinMemory.list({
        scope: args.scope as CodeGoblinMemoryScope | undefined,
        projectID: args.project,
        includeArchived: args.all,
      })
      if (args.json) {
        console.log(JSON.stringify(entries, null, 2))
        return
      }
      if (entries.length === 0) {
        UI.println("No memory entries yet.")
        return
      }
      for (const entry of entries) {
        const flags = [entry.pinned ? "📌" : "", entry.archived ? "(archived)" : ""].filter(Boolean).join(" ")
        const tags = entry.tags.length ? ` [${entry.tags.join(", ")}]` : ""
        UI.println(`${entry.scope.padEnd(7)} ${flags ? flags + " " : ""}${entry.content}${tags}`)
      }
    } catch (err) {
      UI.error(errorMessage(err))
      process.exit(1)
    }
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show a summary of stored memory",
  builder: (yargs: Argv) =>
    yargs.option("json", {
      describe: "output as JSON",
      type: "boolean",
      default: false,
    }),
  handler: async (args) => {
    try {
      const status = CodeGoblinMemory.status()
      if (args.json) {
        console.log(JSON.stringify(status, null, 2))
        return
      }
      UI.println(`Memory entries: ${status.total} total (${status.active} active, ${status.archived} archived)`)
      UI.println(`Pinned: ${status.pinned}`)
      UI.println(`By scope: user ${status.byScope.user}, project ${status.byScope.project}, session ${status.byScope.session}`)
    } catch (err) {
      UI.error(errorMessage(err))
      process.exit(1)
    }
  },
})

export const MemoryCommand = cmd({
  command: "memory",
  describe: "view stored CodeGoblin memory",
  builder: (yargs: Argv) => yargs.command(ListCommand).command(StatusCommand).demandCommand(),
  handler: () => {},
})
