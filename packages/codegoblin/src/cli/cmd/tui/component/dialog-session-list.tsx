import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo, createResource, createSignal, onMount, type JSX } from "solid-js"
import { Locale } from "@/util/locale"
import { useProject } from "@tui/context/project"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { useKV } from "../context/kv"
import { Flag } from "@codegoblin/core/flag/flag"
import { DialogSessionRename } from "./dialog-session-rename"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { openWorkspaceSelect, type WorkspaceSelection, warpWorkspaceSession } from "./dialog-workspace-create"
import { Spinner } from "./spinner"
import { errorMessage } from "@/util/error"
import { DialogSessionDeleteFailed } from "./dialog-session-delete-failed"
import { WorkspaceLabel } from "./workspace-label"
import { useCommandShortcut } from "../keymap"
import { discoverExternalSessions, loadExternalSession, type ExternalSessionSummary } from "@/session/external"
import { DialogConfirm } from "@tui/ui/dialog-confirm"

const EXTERNAL_SESSION_SOURCES_KEY = "external_session_sources"
const externalSources = ["claude-code", "codex", "antigravity", "cursor-agent"] as const
type ExternalSource = (typeof externalSources)[number]

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const project = useProject()
  const { theme } = useTheme()
  const sdk = useSDK()
  const local = useLocal()
  const kv = useKV()
  const toast = useToast()
  const [toDelete, setToDelete] = createSignal<string>()
  const [importing, setImporting] = createSignal<string>()
  const [search, setSearch] = createDebouncedSignal("", 150)
  const deleteHint = useCommandShortcut("session.delete")
  const quickSwitch1 = useCommandShortcut("session.quick_switch.1")
  const quickSwitch9 = useCommandShortcut("session.quick_switch.9")

  const [searchResults, { refetch }] = createResource(
    () => ({ query: search(), filter: sync.session.query() }),
    async (input) => {
      if (!input.query) return undefined
      const result = await sdk.client.session.list({ search: input.query, limit: 30, ...input.filter })
      return result.data ?? []
    },
  )
  const enabledExternalSources = createMemo(() => {
    const saved = kv.get(EXTERNAL_SESSION_SOURCES_KEY, []) as string[]
    return externalSources.filter((source) => saved.includes(source))
  })
  const [externalSessions, { refetch: refreshExternal }] = createResource(enabledExternalSources, (sources) =>
    sources.length ? discoverExternalSessions({ sources }).catch(() => []) : [],
  )
  const externalByID = createMemo(
    () => new Map((externalSessions() ?? []).map((session) => [session.id, session] as const)),
  )

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const sessions = createMemo(() => searchResults() ?? sync.data.session)

  function recover(session: NonNullable<ReturnType<typeof sessions>[number]>) {
    const workspace = project.workspace.get(session.workspaceID!)
    const list = () => dialog.replace(() => <DialogSessionList />)
    const warp = async (selection: WorkspaceSelection) => {
      const workspaceID = await (async () => {
        if (selection.type === "none") return null
        if (selection.type === "existing") return selection.workspaceID
        const result = await sdk.client.experimental.workspace
          .create({ type: selection.workspaceType, branch: null })
          .catch(() => undefined)
        const workspace = result?.data
        if (!workspace) {
          toast.show({
            message: `Failed to create workspace: ${errorMessage(result?.error ?? "no response")}`,
            variant: "error",
          })
          return
        }
        await project.workspace.sync()
        return workspace.id
      })()
      if (workspaceID === undefined) return
      await warpWorkspaceSession({
        dialog,
        sdk,
        sync,
        project,
        toast,
        sourceWorkspaceID: session.workspaceID,
        workspaceID,
        sessionID: session.id,
        copyChanges: false,
        done: list,
      })
    }
    dialog.replace(() => (
      <DialogSessionDeleteFailed
        session={session.title}
        workspace={workspace?.name ?? session.workspaceID!}
        onDone={list}
        onDelete={async () => {
          const current = currentSessionID()
          const info = current ? sync.data.session.find((item) => item.id === current) : undefined
          const result = await sdk.client.experimental.workspace.remove({ id: session.workspaceID! })
          if (result.error) {
            toast.show({
              variant: "error",
              title: "Failed to delete workspace",
              message: errorMessage(result.error),
            })
            return false
          }
          await project.workspace.sync()
          await sync.session.refresh()
          if (search()) await refetch()
          if (info?.workspaceID === session.workspaceID) {
            route.navigate({ type: "home" })
          }
          return true
        }}
        onRestore={() => {
          void openWorkspaceSelect({
            dialog,
            sdk,
            sync,
            project,
            toast,
            onSelect: (selection) => {
              void warp(selection)
            },
          })
          return false
        }}
      />
    ))
  }

  function orderByRecency(sessionsList: NonNullable<ReturnType<typeof sessions>>) {
    return sessionsList
      .filter((x) => x.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .map((x) => x.id)
  }

  const [browseOrder] = createSignal<string[]>(orderByRecency(sync.data.session))

  const quickSwitchHint = createMemo(() => {
    const first = quickSwitch1()
    const last = quickSwitch9()
    if (!first || !last) return undefined
    return quickSwitchRange(first, last)
  })
  const quickSwitchFooterHints = createMemo(() => {
    const hint = quickSwitchHint()
    return hint && local.session.slots().length > 0 ? [{ title: "switch", label: hint }] : []
  })

  const options = createMemo(() => {
    const today = new Date().toDateString()
    const sessionMap = new Map(
      sessions()
        .filter((x) => x.parentID === undefined)
        .map((x) => [x.id, x]),
    )

    const searchResult = searchResults()
    const displayOrder = searchResult ? orderByRecency(searchResult) : browseOrder()

    const pinned = local.session.pinned().filter((id) => sessionMap.has(id))
    const pinnedSet = new Set(pinned)
    const slotByID = new Map<string, number>(local.session.slots().map((id, i) => [id, i + 1]))

    function buildOption(id: string, category: string) {
      const x = sessionMap.get(id)
      if (!x) return undefined
      const workspace = x.workspaceID ? project.workspace.get(x.workspaceID) : undefined

      let footer: JSX.Element | string = ""
      if (Flag.CODEGOBLIN_EXPERIMENTAL_WORKSPACES) {
        if (x.workspaceID) {
          footer = workspace ? (
            <WorkspaceLabel
              type={workspace.type}
              name={workspace.name}
              status={project.workspace.status(x.workspaceID) ?? "error"}
            />
          ) : (
            <WorkspaceLabel type="unknown" name={x.workspaceID} status="error" />
          )
        }
      } else {
        footer = Locale.time(x.time.updated)
      }

      const isDeleting = toDelete() === x.id
      const status = sync.data.session_status?.[x.id]
      const isWorking = status?.type === "busy" || status?.type === "retry"
      const slot = slotByID.get(x.id)
      const gutter = isWorking
        ? () => <Spinner />
        : slot !== undefined
          ? () => <text fg={theme.accent}>{slot}</text>
          : undefined
      return {
        title: isDeleting ? `Press ${deleteHint()} again to confirm` : x.title,
        bg: isDeleting ? theme.error : undefined,
        value: x.id,
        category,
        footer,
        gutter,
      }
    }

    const remaining = displayOrder
      .filter((id) => !pinnedSet.has(id))
      .map((id) => {
        const x = sessionMap.get(id)
        if (!x) return undefined
        const label = new Date(x.time.updated).toDateString()
        return buildOption(id, label === today ? "Today" : label)
      })
      .filter((x) => x !== undefined)

    const query = search().trim().toLowerCase()
    const external = (externalSessions() ?? [])
      .filter((session) => {
        if (!query) return true
        return [session.title, session.directory, session.source].some((value) => value?.toLowerCase().includes(query))
      })
      .map((session) => ({
        title: importing() === session.id ? `Importing ${session.title}...` : session.title,
        value: session.id,
        category: externalSourceName(session.source),
        footer: Locale.time(session.updated),
      }))

    return [
      ...pinned.map((id) => buildOption(id, "Pinned")).filter((x) => x !== undefined),
      ...remaining,
      ...external,
      {
        title: "Manage external session access",
        description: enabledExternalSources().length
          ? `Enabled: ${enabledExternalSources().map(externalSourceName).join(", ")}`
          : "Disabled by default. Choose which local transcript folders CodeGoblin may scan.",
        value: "external:manage",
        category: "Import",
      },
      {
        title: "Refresh external sessions",
        description: "Re-scan the enabled local transcript folders now.",
        value: "external:refresh",
        category: "Import",
      },
    ]
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Sessions"
      options={options()}
      skipFilter={true}
      current={currentSessionID()}
      onFilter={setSearch}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={async (option) => {
        if (option.value === "external:manage") {
          dialog.replace(() => <DialogExternalSessionAccess onDone={() => dialog.replace(() => <DialogSessionList />)} />)
          return
        }
        if (option.value === "external:refresh") {
          await refreshExternal()
          toast.show({ message: "External sessions refreshed", variant: "info" })
          return
        }
        const external = externalByID().get(option.value)
        if (external) {
          await importExternal(external)
          return
        }
        route.navigate({
          type: "session",
          sessionID: option.value,
        })
        dialog.clear()
      }}
      actions={[
        {
          command: "session.pin.toggle",
          title: "pin/unpin",
          onTrigger: (option: { value: string }) => {
            if (externalByID().has(option.value)) return
            local.session.togglePin(option.value)
          },
        },
        {
          command: "session.delete",
          title: "delete",
          onTrigger: async (option) => {
            if (externalByID().has(option.value)) return
            if (toDelete() === option.value) {
              const session = sessions().find((item) => item.id === option.value)
              const status = session?.workspaceID ? project.workspace.status(session.workspaceID) : undefined

              try {
                const result = await sdk.client.session.delete({
                  sessionID: option.value,
                })
                if (result.error) {
                  if (session?.workspaceID) {
                    recover(session)
                  } else {
                    toast.show({
                      variant: "error",
                      title: "Failed to delete session",
                      message: errorMessage(result.error),
                    })
                  }
                  setToDelete(undefined)
                  return
                }
              } catch (err) {
                if (session?.workspaceID) {
                  recover(session)
                } else {
                  toast.show({
                    variant: "error",
                    title: "Failed to delete session",
                    message: errorMessage(err),
                  })
                }
                setToDelete(undefined)
                return
              }
              if (status && status !== "connected") {
                await sync.session.refresh()
              }
              if (search()) await refetch()
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
        {
          command: "session.rename",
          title: "rename",
          onTrigger: async (option) => {
            if (externalByID().has(option.value)) return
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
      ]}
      footerHints={quickSwitchFooterHints()}
    />
  )

  async function importExternal(external: ExternalSessionSummary) {
    if (importing()) return
    setImporting(external.id)
    const transcript = await loadExternalSession(external).catch((error) => {
      toast.show({ variant: "error", title: "Import failed", message: errorMessage(error) })
      return undefined
    })
    if (!transcript) {
      setImporting(undefined)
      return
    }

    const selected = local.model.current()
    const result = await sdk.client.session
      .importExternal({
        source: transcript.source,
        title: `${externalSourceName(transcript.source)} · ${transcript.title}`,
        model: selected
          ? {
              providerID: selected.providerID,
              id: selected.modelID,
              variant: local.model.variant.current(),
            }
          : undefined,
        messages: transcript.messages,
      })
      .catch((error) => ({ error, data: undefined }))
    setImporting(undefined)
    if (result.error || !result.data) {
      toast.show({ variant: "error", title: "Import failed", message: errorMessage(result.error ?? "no response") })
      return
    }
    await sync.session.refresh()
    route.navigate({ type: "session", sessionID: result.data.id })
    dialog.clear()
  }
}

function DialogExternalSessionAccess(props: { onDone: () => void }) {
  const dialog = useDialog()
  const kv = useKV()
  const enabled = createMemo(() => {
    const saved = kv.get(EXTERNAL_SESSION_SOURCES_KEY, []) as string[]
    return new Set(externalSources.filter((source) => saved.includes(source)))
  })

  return (
    <DialogSelect
      title="External session access"
      options={[
        ...externalSources.map((source) => ({
          title: `${externalSourceName(source)}: ${enabled().has(source) ? "enabled" : "disabled"}`,
          description: externalSourceDescription(source),
          value: source,
        })),
        { title: "Done", value: "done" },
      ]}
      onSelect={async (option) => {
        if (option.value === "done") {
          props.onDone()
          return
        }
        const source = option.value as ExternalSource
        if (enabled().has(source)) {
          kv.set(
            EXTERNAL_SESSION_SOURCES_KEY,
            [...enabled()].filter((item) => item !== source),
          )
          dialog.replace(() => <DialogExternalSessionAccess onDone={props.onDone} />)
          return
        }
        const confirmed = await DialogConfirm.show(
          dialog,
          `Allow ${externalSourceName(source)} access?`,
          `CodeGoblin will read local ${externalSourceName(source)} transcript files to list and import conversations. It never uploads, changes, or background-watches those files.`,
          "Allow local access",
        )
        if (confirmed) kv.set(EXTERNAL_SESSION_SOURCES_KEY, [...enabled(), source])
        dialog.replace(() => <DialogExternalSessionAccess onDone={props.onDone} />)
      }}
    />
  )
}

function externalSourceName(source: ExternalSource) {
  if (source === "claude-code") return "Claude Code"
  if (source === "codex") return "Codex"
  if (source === "antigravity") return "Antigravity"
  return "Cursor"
}

function externalSourceDescription(source: ExternalSource) {
  if (source === "claude-code") return "Allow CodeGoblin to scan ~/.claude/projects only when you open /resume."
  if (source === "codex") return "Allow CodeGoblin to scan ~/.codex/sessions only when you open /resume."
  if (source === "antigravity") return "Allow CodeGoblin to scan Antigravity's local brain transcripts only when you open /resume."
  return "Allow CodeGoblin to ask the installed Cursor Agent CLI for its session list only when you open /resume."
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}
