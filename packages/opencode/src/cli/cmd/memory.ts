import type { Argv } from "yargs"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { CodeGoblinMemory, CodeGoblinMemoryError, type CodeGoblinMemoryScope } from "@/codegoblin/memory"
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
        UI.println(`${entry.id}  ${entry.scope.padEnd(7)} ${flags ? flags + " " : ""}${entry.content}${tags}`)
      }
    } catch (err) {
      UI.error(errorMessage(err))
      process.exit(1)
    }
  },
})

const AddCommand = cmd({
  command: "add <content>",
  describe: "store a new memory entry",
  builder: (yargs: Argv) =>
    yargs
      .positional("content", {
        describe: "the fact to remember",
        type: "string",
        demandOption: true,
      })
      .option("scope", {
        describe: "scope for the entry",
        type: "string",
        choices: SCOPES as unknown as string[],
        default: "user",
      })
      .option("project", {
        describe: "project id (required for project scope)",
        type: "string",
      })
      .option("tag", {
        describe: "tag to attach (repeatable)",
        type: "string",
        array: true,
      })
      .option("pin", {
        describe: "pin this entry so it is always surfaced first",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    try {
      const entry = CodeGoblinMemory.add({
        scope: args.scope as CodeGoblinMemoryScope,
        content: args.content as string,
        projectID: args.project,
        tags: args.tag as string[] | undefined,
        pinned: args.pin,
      })
      UI.println(`Stored ${entry.id} (${entry.scope}).`)
    } catch (err) {
      if (err instanceof CodeGoblinMemoryError) {
        UI.error(err.message)
        process.exit(1)
      }
      UI.error(errorMessage(err))
      process.exit(1)
    }
  },
})

const RemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["rm", "forget"],
  describe: "archive a memory entry by id",
  builder: (yargs: Argv) =>
    yargs.positional("id", {
      describe: "the memory id to archive",
      type: "string",
      demandOption: true,
    }),
  handler: async (args) => {
    try {
      const removed = CodeGoblinMemory.remove(args.id as string)
      if (removed) UI.println(`Archived ${args.id}.`)
      else {
        UI.error(`No memory found with id ${args.id}.`)
        process.exit(1)
      }
    } catch (err) {
      UI.error(errorMessage(err))
      process.exit(1)
    }
  },
})

const PinCommand = cmd({
  command: "pin <id>",
  describe: "pin a memory entry",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { describe: "the memory id", type: "string", demandOption: true })
      .option("off", { describe: "unpin instead of pin", type: "boolean", default: false }),
  handler: async (args) => {
    try {
      const ok = CodeGoblinMemory.setPinned(args.id as string, !args.off)
      if (ok) UI.println(`${args.off ? "Unpinned" : "Pinned"} ${args.id}.`)
      else {
        UI.error(`No memory found with id ${args.id}.`)
        process.exit(1)
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
  describe: "view and manage stored CodeGoblin memory",
  builder: (yargs: Argv) =>
    yargs
      .command(ListCommand)
      .command(AddCommand)
      .command(RemoveCommand)
      .command(PinCommand)
      .command(StatusCommand)
      .demandCommand(),
  handler: () => {},
})
