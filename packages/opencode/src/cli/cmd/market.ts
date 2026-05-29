import type { Argv } from "yargs"
import path from "path"
import { modify, applyEdits } from "jsonc-parser"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Filesystem } from "@/util/filesystem"
import { Market, type MarketEntry, type MarketKind } from "@/codegoblin/market"
import { errorMessage } from "../../util/error"

const KINDS = ["mcp", "skill", "plugin"] as const

function kindLabel(kind: MarketKind) {
  return kind === "mcp" ? "MCP" : kind === "skill" ? "Skill" : "Plugin"
}

function printEntry(entry: MarketEntry) {
  UI.println(`${entry.id}  [${kindLabel(entry.kind)} · ${entry.category}]`)
  UI.println(`  ${entry.name} — ${entry.description}`)
  if (entry.homepage) UI.println(`  ${entry.homepage}`)
}

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "browse the catalog of MCP servers, skills, and plugins",
  builder: (yargs: Argv) =>
    yargs
      .option("kind", { describe: "filter by kind", type: "string", choices: KINDS as unknown as string[] })
      .option("category", { describe: "filter by category", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  handler: async (args) => {
    const entries = Market.list({
      kind: args.kind as MarketKind | undefined,
      category: args.category,
    })
    if (args.json) {
      console.log(JSON.stringify(entries, null, 2))
      return
    }
    if (entries.length === 0) {
      UI.println("No catalog entries match that filter.")
      return
    }
    UI.println(`CodeGoblin Market — ${entries.length} integrations`)
    UI.empty()
    for (const entry of entries) {
      printEntry(entry)
      UI.empty()
    }
    UI.println("Use `cg market show <id>` for setup details, or `cg market add <id>` to install an MCP server.")
  },
})

const ShowCommand = cmd({
  command: "show <id>",
  describe: "show setup details for a catalog entry",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { describe: "catalog entry id", type: "string", demandOption: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  handler: async (args) => {
    const entry = Market.get(args.id as string)
    if (!entry) {
      UI.error(`No catalog entry with id '${args.id}'. Run 'cg market list' to see options.`)
      process.exit(1)
    }
    if (args.json) {
      console.log(JSON.stringify(entry, null, 2))
      return
    }
    printEntry(entry)
    UI.empty()
    if (entry.env?.length) {
      UI.println("Required environment variables:")
      for (const env of entry.env) UI.println(`  ${env.name} — ${env.description}`)
      UI.empty()
    }
    if (entry.kind === "mcp" && entry.mcp) {
      UI.println("opencode.json snippet:")
      UI.println(JSON.stringify({ mcp: { [entry.id]: entry.mcp } }, null, 2))
      UI.empty()
      UI.println(`Run \`cg market add ${entry.id}\` to write this into your project config.`)
    } else if (entry.install) {
      UI.println(`Install: ${entry.install}`)
    }
  },
})

const AddCommand = cmd({
  command: "add <id>",
  describe: "add a catalog MCP server to your project config (opencode.json)",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { describe: "catalog entry id", type: "string", demandOption: true })
      .option("print", { describe: "print the snippet instead of writing it", type: "boolean", default: false }),
  handler: async (args) => {
    const entry = Market.get(args.id as string)
    if (!entry) {
      UI.error(`No catalog entry with id '${args.id}'. Run 'cg market list' to see options.`)
      process.exit(1)
    }
    if (entry.kind !== "mcp" || !entry.mcp) {
      UI.error(`'${entry.id}' is a ${kindLabel(entry.kind)}, not an MCP server. Run 'cg market show ${entry.id}'.`)
      process.exit(1)
    }
    if (args.print) {
      console.log(JSON.stringify({ mcp: { [entry.id]: entry.mcp } }, null, 2))
      return
    }
    try {
      const configPath = await resolveConfigPath(process.cwd())
      let text = "{}"
      if (await Filesystem.exists(configPath)) text = await Filesystem.readText(configPath)
      const edits = modify(text, ["mcp", entry.id], entry.mcp, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      })
      await Filesystem.write(configPath, applyEdits(text, edits))
      UI.println(`Added '${entry.id}' MCP server to ${configPath}.`)
      if (entry.env?.length) {
        UI.empty()
        UI.println("Set these environment variables before starting CodeGoblin:")
        for (const env of entry.env) UI.println(`  ${env.name} — ${env.description}`)
      }
      UI.empty()
      UI.println("Restart CodeGoblin (or run `cg mcp list`) to connect the new server.")
    } catch (err) {
      UI.error(errorMessage(err))
      process.exit(1)
    }
  },
})

async function resolveConfigPath(baseDir: string) {
  const candidates = [
    path.join(baseDir, "opencode.json"),
    path.join(baseDir, "opencode.jsonc"),
    path.join(baseDir, ".opencode", "opencode.json"),
    path.join(baseDir, ".opencode", "opencode.jsonc"),
  ]
  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) return candidate
  }
  return candidates[0]
}

export const MarketCommand = cmd({
  command: "market",
  describe: "browse and install MCP servers, skills, and plugins",
  builder: (yargs: Argv) =>
    yargs.command(ListCommand).command(ShowCommand).command(AddCommand).demandCommand(),
  handler: () => {},
})
