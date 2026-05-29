import { createMemo, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { TextAttributes } from "@opentui/core"
import { useProject } from "../context/project"
import { useTheme } from "../context/theme"
import { Market, type MarketEntry } from "@/codegoblin/market"

function kindLabel(kind: MarketEntry["kind"]) {
  return kind === "mcp" ? "MCP" : kind === "skill" ? "Skill" : "Plugin"
}

function statusLabel(status?: string) {
  switch (status) {
    case "connected":
      return "connected"
    case "needs_auth":
      return "needs auth"
    case "needs_client_registration":
      return "needs client id"
    case "failed":
      return "failed"
    case "disabled":
      return "disabled"
    default:
      return "not added"
  }
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
  } else if (entry.install) {
    lines.push("")
    lines.push(`Install: ${entry.install}`)
  }
  return lines.join("\n")
}

export function DialogMarket() {
  const dialog = useDialog()
  const sync = useSync()
  const { theme } = useTheme()

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const mcpData = sync.data.mcp ?? {}
    return Market.list().map((entry) => {
      const live = entry.kind === "mcp" ? statusLabel(mcpData[entry.id]?.status) : kindLabel(entry.kind)
      const connected = entry.kind === "mcp" && mcpData[entry.id]?.status === "connected"
      return {
        title: `${entry.name}  [${kindLabel(entry.kind)} · ${entry.category}]`,
        description: entry.description,
        value: entry.id,
        footer: (
          <span
            style={{
              fg: connected ? theme.success : theme.textMuted,
              attributes: connected ? TextAttributes.BOLD : undefined,
            }}
          >
            {live}
          </span>
        ),
      }
    })
  })

  return (
    <DialogSelect
      title="CodeGoblin Market"
      options={options()}
      onSelect={(option) => {
        const entry = Market.get(option.value)
        if (!entry) return
        dialog.replace(() => <DialogMarketEntry entry={entry} />)
      }}
    />
  )
}

function DialogMarketEntry(props: { entry: MarketEntry }) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const [busy, setBusy] = createSignal(false)

  const status = createMemo(() => sync.data.mcp?.[props.entry.id]?.status)

  async function refresh() {
    const result = await sdk.client.mcp.status()
    if (result.data) sync.set("mcp", result.data)
  }

  function done(message: string, title = props.entry.name) {
    dialog.replace(() => <DialogAlert title={title} message={message} />)
  }

  async function run(label: string, action: () => Promise<void>) {
    if (busy()) return
    setBusy(true)
    try {
      await action()
      await refresh()
      done(`${props.entry.name}: ${label} — status is now ${statusLabel(status())}.`)
    } catch (error) {
      done(
        error instanceof Error ? error.message : `Could not ${label.toLowerCase()} ${props.entry.name}.`,
        "Market error",
      )
    } finally {
      setBusy(false)
    }
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const result: DialogSelectOption<string>[] = []
    if (props.entry.kind === "mcp" && props.entry.mcp) {
      const current = status()
      if (!current) {
        result.push({
          title: "Add to project & connect",
          description: "Write the MCP entry to opencode.json and connect it now.",
          value: "install",
        })
      } else {
        if (current !== "connected") {
          result.push({
            title: current === "needs_auth" ? "Authenticate (opens browser)" : "Connect / retry",
            description:
              current === "needs_auth"
                ? "Start the OAuth flow for this server in your browser."
                : "Attempt to connect this MCP server again.",
            value: current === "needs_auth" ? "authenticate" : "connect",
          })
        }
        if (current === "connected" || current === "needs_auth" || current === "failed") {
          result.push({
            title: "Disconnect",
            description: "Disable this MCP server for the session.",
            value: "disconnect",
          })
        }
        result.push({ title: "Reconnect", description: "Reconnect this MCP server.", value: "connect" })
      }
    }
    result.push({ title: "View details", value: "details" })
    result.push({ title: "Back to market", value: "back" })
    return result
  })

  return (
    <DialogSelect
      title={`${props.entry.name} · ${
        props.entry.kind === "mcp" ? statusLabel(status()) : kindLabel(props.entry.kind)
      }`}
      options={options()}
      onSelect={(option) => {
        const entry = props.entry
        switch (option.value) {
          case "install":
            void run("Added & connected", async () => {
              await Market.addToConfig(entry, project.instance.path().directory || process.cwd())
              if (entry.mcp) await sdk.client.mcp.add({ name: entry.id, config: entry.mcp })
            })
            break
          case "connect":
            void run("Connected", async () => {
              await sdk.client.mcp.connect({ name: entry.id })
            })
            break
          case "authenticate":
            void run("Authentication started", async () => {
              await sdk.client.mcp.auth.authenticate({ name: entry.id })
            })
            break
          case "disconnect":
            void run("Disconnected", async () => {
              await sdk.client.mcp.disconnect({ name: entry.id })
            })
            break
          case "details":
            dialog.replace(() => <DialogAlert title={entry.name} message={detailMessage(entry)} />)
            break
          case "back":
            dialog.replace(() => <DialogMarket />)
            break
        }
      }}
    />
  )
}
