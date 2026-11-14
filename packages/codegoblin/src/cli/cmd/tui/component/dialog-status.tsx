import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { InstallationVersion } from "@codegoblin/core/installation/version"
import { fileURLToPath } from "bun"
import path from "node:path"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useProject } from "@tui/context/project"
import { useToast } from "@tui/ui/toast"
import { useBindings } from "../keymap"
import * as Clipboard from "@tui/util/clipboard"
import { For, Match, Switch, Show, createMemo, createResource, createSignal, onMount } from "solid-js"

export function DialogStatus() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const route = useRoute()
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const [tab, setTab] = createSignal<"status" | "connections">("status")
  const [health, { refetch }] = createResource(async () => {
    const result = await sdk.client.global.health({ throwOnError: true })
    return result.data
  })
  let scroll: ScrollBoxRenderable | undefined
  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const session = () => {
    const id = sessionID()
    return id ? sync.session.get(id) : undefined
  }
  const provider = () => sync.data.provider.find((item) => item.id === local.model.current()?.providerID)
  const mcpSummary = createMemo(() => {
    const statuses = Object.values(sync.data.mcp)
    return (
      [
        ["connected", "connected"],
        ["needs_auth", "need auth"],
        ["failed", "failed"],
        ["needs_client_registration", "need registration"],
        ["disabled", "disabled"],
      ]
        .flatMap(([status, label]) => {
          const count = statuses.filter((item) => item.status === status).length
          return count ? [`${count} ${label}`] : []
        })
        .join(" · ") || "None configured"
    )
  })
  const rows = createMemo(() => [
    { label: "Version", value: InstallationVersion },
    { label: "Session name", value: session()?.title ?? (sessionID() ? "Loading…" : "No session open") },
    { label: "Session ID", value: sessionID() ?? "No session open" },
    {
      label: "Session type",
      value: sessionID() ? (session()?.parentID ? "Child conversation" : "Conversation") : "Home",
    },
    ...(session()?.parentID ? [{ label: "Parent session", value: session()!.parentID! }] : []),
    { label: "Working directory", value: project.instance.directory() || sdk.directory || "Unknown" },
    { label: "Git branch", value: sync.data.vcs?.branch ?? "Not available" },
    { label: "Model", value: local.model.current()?.modelID ?? "Not selected" },
    { label: "Provider", value: provider()?.name ?? local.model.current()?.providerID ?? "Not selected" },
    {
      label: "Credential source",
      value: provider()
        ? { env: "Environment", api: "Saved credential", config: "Configuration", custom: "Provider integration" }[
            provider()!.source
          ]
        : "Not selected",
    },
    { label: "Agent / mode", value: local.agent.current()?.name ?? "Not selected" },
    { label: "Model variant", value: local.model.variant.current() ?? "Default" },
    {
      label: "Session state",
      value: sessionID() ? (sync.data.session_status[sessionID()!]?.type ?? "idle") : "No session open",
    },
    { label: "Server", value: new URL(sdk.url).origin },
    {
      label: "Server health",
      value: health.error
        ? "Unavailable"
        : health.loading
          ? "Checking…"
          : health()?.healthy
            ? "Healthy"
            : "Unavailable",
    },
    ...(!health.error && health()?.version ? [{ label: "Server version", value: health()!.version }] : []),
    { label: "MCP servers", value: mcpSummary() },
    { label: "Config directory", value: project.instance.path().config || "Not reported by server" },
  ])
  const copyID = () => {
    const id = sessionID()
    if (!id) return
    void Clipboard.copy(id).then(
      () => toast.show({ message: "Session ID copied", variant: "success" }),
      () => toast.show({ message: "Could not copy session ID", variant: "error" }),
    )
  }
  const changeTab = () => {
    setTab((value) => (value === "status" ? "connections" : "status"))
    scroll?.scrollTo(0)
  }
  onMount(() => dialog.setSize("large"))
  useBindings(() => ({
    bindings: [
      { key: "left", desc: "Previous tab", group: "Dialog", cmd: changeTab },
      { key: "right", desc: "Next tab", group: "Dialog", cmd: changeTab },
      { key: "tab", desc: "Next tab", group: "Dialog", cmd: changeTab },
      { key: "c", desc: "Copy session ID", group: "Dialog", cmd: copyID },
      {
        key: "r",
        desc: "Refresh server health",
        group: "Dialog",
        cmd: () => {
          void refetch()
        },
      },
      { key: "up", desc: "Scroll up", group: "Dialog", cmd: () => scroll?.scrollBy(-1) },
      { key: "down", desc: "Scroll down", group: "Dialog", cmd: () => scroll?.scrollBy(1) },
      { key: "pageup", desc: "Previous page", group: "Dialog", cmd: () => scroll?.scrollBy(-10) },
      { key: "pagedown", desc: "Next page", group: "Dialog", cmd: () => scroll?.scrollBy(10) },
    ],
  }))

  const enabledFormatters = createMemo(() => sync.data.formatter.filter((f) => f.enabled))

  const plugins = createMemo(() => {
    const list = sync.data.config.plugin ?? []
    const result = list.map((item) => {
      const value = typeof item === "string" ? item : item[0]
      if (value.startsWith("file://")) {
        const file = fileURLToPath(value)
        const name = path.basename(file, path.extname(file))
        return { name: name === "index" ? path.basename(path.dirname(file)) : name }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      gap={1}
      paddingBottom={1}
      height={Math.max(5, Math.min(30, Math.floor(dimensions().height * 0.75) - 2))}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <For each={["status", "connections"] as const}>
          {(value) => (
            <text
              id={`status-tab-${value}`}
              fg={tab() === value ? theme.accent : theme.textMuted}
              attributes={tab() === value ? TextAttributes.BOLD : undefined}
              onMouseUp={() => {
                if (tab() !== value) changeTab()
              }}
            >
              {value === "status" ? "Status" : "Connections"}
            </text>
          )}
        </For>
      </box>
      <scrollbox ref={scroll} flexGrow={1} minHeight={1} paddingRight={1}>
        <box gap={1}>
          <Show when={tab() === "status"}>
            <box>
              <For each={rows()}>
                {(row) => (
                  <box flexDirection={dimensions().width < 60 ? "column" : "row"}>
                    <text width={dimensions().width < 60 ? undefined : 19} flexShrink={0} fg={theme.textMuted}>
                      {row.label}:
                    </text>
                    <text
                      id={row.label === "Session ID" ? "status-session-id" : undefined}
                      flexGrow={1}
                      flexShrink={1}
                      fg={theme.text}
                      wrapMode="word"
                      onMouseUp={row.label === "Session ID" ? copyID : undefined}
                    >
                      {row.value}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
          <Show when={tab() === "connections"}>
            <Show when={Object.keys(sync.data.mcp).length > 0} fallback={<text fg={theme.text}>No MCP Servers</text>}>
              <box>
                <text fg={theme.text}>{Object.keys(sync.data.mcp).length} MCP Servers</text>
                <For each={Object.entries(sync.data.mcp)}>
                  {([key, item]) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: (
                            {
                              connected: theme.success,
                              failed: theme.error,
                              disabled: theme.textMuted,
                              needs_auth: theme.warning,
                              needs_client_registration: theme.error,
                            } as Record<string, typeof theme.success>
                          )[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.text} wrapMode="word">
                        <b>{key}</b>{" "}
                        <span style={{ fg: theme.textMuted }}>
                          <Switch fallback={item.status}>
                            <Match when={item.status === "connected"}>Connected</Match>
                            <Match when={item.status === "failed" && item}>{(val) => val().error}</Match>
                            <Match when={item.status === "disabled"}>Disabled in configuration</Match>
                            <Match when={(item.status as string) === "needs_auth"}>
                              Needs authentication (run: codegoblin mcp auth {key})
                            </Match>
                            <Match when={(item.status as string) === "needs_client_registration" && item}>
                              {(val) => (val() as { error: string }).error}
                            </Match>
                          </Switch>
                        </span>
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
            {sync.data.lsp.length > 0 && (
              <box>
                <text fg={theme.text}>{sync.data.lsp.length} LSP Servers</text>
                <For each={sync.data.lsp}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: {
                            connected: theme.success,
                            error: theme.error,
                          }[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.text} wrapMode="word">
                        <b>{item.id}</b> <span style={{ fg: theme.textMuted }}>{item.root}</span>
                      </text>
                    </box>
                  )}
                </For>
              </box>
            )}
            <Show when={enabledFormatters().length > 0} fallback={<text fg={theme.text}>No Formatters</text>}>
              <box>
                <text fg={theme.text}>{enabledFormatters().length} Formatters</text>
                <For each={enabledFormatters()}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: theme.success,
                        }}
                      >
                        •
                      </text>
                      <text wrapMode="word" fg={theme.text}>
                        <b>{item.name}</b>
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
            <Show when={plugins().length > 0} fallback={<text fg={theme.text}>No Plugins</text>}>
              <box>
                <text fg={theme.text}>{plugins().length} Plugins</text>
                <For each={plugins()}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: theme.success,
                        }}
                      >
                        •
                      </text>
                      <text wrapMode="word" fg={theme.text}>
                        <b>{item.name}</b>
                        {item.version && <span style={{ fg: theme.textMuted }}> @{item.version}</span>}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
          </Show>
        </box>
      </scrollbox>
      <text fg={theme.textMuted} wrapMode="word" flexShrink={0}>
        ←/→ tabs · ↑/↓ scroll · {sessionID() ? "c copy ID · " : ""}r refresh · /usage for spend
      </text>
    </box>
  )
}
