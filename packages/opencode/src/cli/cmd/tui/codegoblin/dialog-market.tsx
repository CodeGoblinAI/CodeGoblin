import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { useDialog } from "@tui/ui/dialog"
import { Market, type MarketEntry } from "@/codegoblin/market"

// TUI browser for the CodeGoblin market. Mirrors the `cg market` CLI command:
// pick an integration to see its setup details and the opencode.json snippet.
// Installing (writing config) stays on the CLI via `cg market add <id>` to
// keep the dialog read-only and side-effect free.

function kindLabel(kind: MarketEntry["kind"]) {
  return kind === "mcp" ? "MCP" : kind === "skill" ? "Skill" : "Plugin"
}

function detailMessage(entry: MarketEntry): string {
  const lines: string[] = []
  lines.push(`${entry.name} — ${kindLabel(entry.kind)} · ${entry.category}`)
  lines.push("")
  lines.push(entry.description)
  if (entry.homepage) {
    lines.push("")
    lines.push(entry.homepage)
  }
  if (entry.env?.length) {
    lines.push("")
    lines.push("Required environment variables:")
    for (const env of entry.env) lines.push(`  ${env.name} — ${env.description}`)
  }
  if (entry.kind === "mcp" && entry.mcp) {
    lines.push("")
    lines.push("opencode.json snippet:")
    lines.push(JSON.stringify({ mcp: { [entry.id]: entry.mcp } }, null, 2))
    lines.push("")
    lines.push(`Run \`cg market add ${entry.id}\` to write this into your project config.`)
  } else if (entry.install) {
    lines.push("")
    lines.push(`Install: ${entry.install}`)
  }
  return lines.join("\n")
}

export function DialogMarket() {
  const dialog = useDialog()

  const options: DialogSelectOption<string>[] = Market.list().map((entry) => ({
    title: `${entry.name}  [${kindLabel(entry.kind)} · ${entry.category}]`,
    description: entry.description,
    value: entry.id,
  }))

  return (
    <DialogSelect
      title="CodeGoblin Market"
      options={options}
      onSelect={(option) => {
        const entry = Market.get(option.value)
        if (!entry) return
        dialog.replace(() => <DialogAlert title={entry.name} message={detailMessage(entry)} />)
      }}
    />
  )
}
