import { createEffect, createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { produce } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { DateTime } from "luxon"
import { base64Encode } from "@codegoblin/core/util/encode"
import { getFilename } from "@codegoblin/core/util/path"
import type { Session } from "@codegoblin/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { getAvatarColors, useLayout, type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { pathKey } from "@/utils/path-key"
import { sessionTitle } from "@/utils/session-title"
import { sortedRootSessions, displayName } from "@/pages/layout/helpers"
import { CodeGoblinLogoMark } from "@/components/codegoblin-logo"
import { Button } from "@codegoblin/ui/button"
import { Dialog } from "@codegoblin/ui/dialog"
import { DropdownMenu } from "@codegoblin/ui/dropdown-menu"
import { TextField } from "@codegoblin/ui/text-field"
import { showToast } from "@codegoblin/ui/toast"
import { useDialog } from "@codegoblin/ui/context/dialog"
import { Avatar as AvatarV2 } from "@codegoblin/ui/v2/components/avatar-v2.jsx"
import { IconButtonV2 } from "@codegoblin/ui/v2/components/icon-button-v2.jsx"
import { Icon as IconV2 } from "@codegoblin/ui/v2/components/icon.jsx"

const ROW_BASE =
  "flex min-w-0 w-full items-center rounded-[6px] border-0 bg-transparent text-left text-[13px] [font-weight:440] text-v2-text-text-muted transition-colors duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none cursor-default"
const SECTION_LABEL = "px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint select-none"

const SESSION_LIMIT = 20

type SidebarSession = { session: Session; project: LocalProject | undefined; storeDir: string }

export function ThreePaneSidebar(props: {
  projects: Accessor<LocalProject[]>
  currentDir: Accessor<string>
  onNewChat: () => void
  onOpenProject: () => void
  onNoProject: () => void
  onQuickStart: () => void
  onOpenSettings: () => void
  onOpenHelp: () => void
}) {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const server = useServer()
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams()

  const projectByWorktree = createMemo(() => new Map(props.projects().map((p) => [pathKey(p.worktree), p])))

  // Directories whose sessions the sidebar lists: every project, the active dir,
  // and the home dir. Home matters because "no project" chats are rooted there —
  // and so are sessions started from the TUI in non-project folders. Without it
  // those chats vanish from the list the moment you navigate away.
  const sessionDirs = createMemo(() => {
    const dirs = new Map<string, string>()
    for (const p of props.projects()) dirs.set(pathKey(p.worktree), p.worktree)
    const current = props.currentDir()
    if (current) dirs.set(pathKey(current), current)
    const home = globalSync.data.path.home
    if (home) dirs.set(pathKey(home), home)
    return [...dirs.values()]
  })

  // Pull the session list for every sidebar directory so the chat list actually
  // populates. globalSync.child uses bootstrap:false, so the lists never load on
  // their own; loadSessions is deduped, safe to call here.
  createEffect(() => {
    for (const dir of sessionDirs()) void globalSync.project.loadSessions(dir)
  })

  const sidebarSessions = createMemo(() => {
    const now = Date.now()
    const seen = new Set<string>()
    const results: SidebarSession[] = []

    for (const dir of sessionDirs()) {
      const [store] = globalSync.child(dir, { bootstrap: false })
      for (const session of sortedRootSessions(store, now)) {
        const key = `${pathKey(session.directory)}:${session.id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({
          session,
          project: projectByWorktree().get(pathKey(session.directory)) ?? projectByWorktree().get(pathKey(dir)),
          storeDir: dir,
        })
      }
    }

    return results
      .sort(
        (a, b) =>
          (b.session.time.updated ?? b.session.time.created) - (a.session.time.updated ?? a.session.time.created),
      )
      .slice(0, SESSION_LIMIT)
  })

  const groups = createMemo(() => {
    const now = DateTime.local()
    const yesterday = now.minus({ days: 1 })
    const sessions = sidebarSessions()

    const toGroup = (id: "today" | "yesterday" | "older", label: string, test: (s: SidebarSession) => boolean) => {
      const items = sessions.filter(test)
      if (items.length === 0) return null
      return { id, label, items }
    }

    return [
      toGroup("today", language.t("home.sessions.group.today"), ({ session }) =>
        DateTime.fromMillis(session.time.updated ?? session.time.created).hasSame(now, "day"),
      ),
      toGroup("yesterday", language.t("home.sessions.group.yesterday"), ({ session }) =>
        DateTime.fromMillis(session.time.updated ?? session.time.created).hasSame(yesterday, "day"),
      ),
      toGroup("older", language.t("home.sessions.group.older"), ({ session }) => {
        const t = DateTime.fromMillis(session.time.updated ?? session.time.created)
        return !t.hasSame(now, "day") && !t.hasSame(yesterday, "day")
      }),
    ].filter((g): g is NonNullable<typeof g> => g !== null)
  })

  const activeSessionId = () => params.id
  const activeDir = () => props.currentDir()

  function openSession(session: Session) {
    const project =
      projectByWorktree().get(pathKey(session.directory)) ??
      props.projects().find((p) => p.sandboxes?.some((s) => pathKey(s) === pathKey(session.directory)))
    const root = project?.worktree ?? session.directory
    layout.projects.open(root)
    server.projects.touch(root)
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  function openProject(project: LocalProject) {
    layout.projects.open(project.worktree)
    server.projects.touch(project.worktree)
    navigate(`/${base64Encode(project.worktree)}/session`)
  }

  const globalSDK = useGlobalSDK()
  const dialog = useDialog()

  function renameSession(item: SidebarSession, title: string) {
    void globalSDK.client.session
      .update({ directory: item.session.directory, sessionID: item.session.id, title })
      .then(() => {
        const [, setStore] = globalSync.child(item.storeDir, { bootstrap: false })
        setStore(
          produce((draft) => {
            const match = draft.session.find((s) => s.id === item.session.id)
            if (match) match.title = title
          }),
        )
      })
      .catch(() => showToast({ variant: "error", icon: "circle-x", title: language.t("common.requestFailed") }))
  }

  function removeFromStore(item: SidebarSession) {
    const [, setStore] = globalSync.child(item.storeDir, { bootstrap: false })
    setStore(
      produce((draft) => {
        const removed = new Set<string>([item.session.id])
        for (;;) {
          const before = removed.size
          for (const s of draft.session) {
            if (s.parentID && removed.has(s.parentID)) removed.add(s.id)
          }
          if (removed.size === before) break
        }
        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )
    if (params.id === item.session.id) navigate(`/${base64Encode(item.storeDir)}/session`)
  }

  function archiveSession(item: SidebarSession) {
    void globalSDK.client.session
      .update({ directory: item.session.directory, sessionID: item.session.id, time: { archived: Date.now() } })
      .then(() => removeFromStore(item))
      .catch(() => showToast({ variant: "error", icon: "circle-x", title: language.t("common.requestFailed") }))
  }

  function deleteSession(item: SidebarSession) {
    void globalSDK.client.session
      .delete({ directory: item.session.directory, sessionID: item.session.id })
      .then(() => removeFromStore(item))
      .catch(() => showToast({ variant: "error", icon: "circle-x", title: language.t("session.delete.failed.title") }))
  }

  function showRenameDialog(item: SidebarSession) {
    dialog.show(() => {
      const [draft, setDraft] = createSignal(sessionTitle(item.session.title) ?? "")
      const submit = () => {
        const value = draft().trim()
        dialog.close()
        if (!value || value === item.session.title) return
        renameSession(item, value)
      }
      return (
        <Dialog title={language.t("common.rename")} fit>
          <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
            <TextField
              value={draft()}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === "Enter") submit()
              }}
              autofocus
            />
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button variant="primary" size="large" onClick={submit}>
                {language.t("common.save")}
              </Button>
            </div>
          </div>
        </Dialog>
      )
    })
  }

  function showDeleteDialog(item: SidebarSession) {
    dialog.show(() => {
      const name = sessionTitle(item.session.title) ?? language.t("command.session.new")
      return (
        <Dialog title={language.t("session.delete.title")} fit>
          <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
            <span class="text-14-regular text-text-strong">{language.t("session.delete.confirm", { name })}</span>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="large"
                onClick={() => {
                  dialog.close()
                  deleteSession(item)
                }}
              >
                {language.t("session.delete.button")}
              </Button>
            </div>
          </div>
        </Dialog>
      )
    })
  }

  return (
    <nav
      aria-label="Projects and chats"
      class="flex h-full w-[220px] shrink-0 flex-col overflow-hidden border-r border-v2-border-border-weaker bg-v2-background-bg-deep"
    >
      {/* Header: logo + new chat */}
      <div class="flex h-11 shrink-0 items-center gap-2 px-3 border-b border-v2-border-border-weaker">
        <CodeGoblinLogoMark size="sm" />
        <span class="flex-1 min-w-0 text-[14px] font-semibold text-v2-text-text-base truncate">CodeGoblin</span>
        <IconButtonV2
          variant="ghost-muted"
          size="large"
          icon={<IconV2 name="new-session" />}
          onClick={props.onNewChat}
          aria-label={language.t("command.session.new")}
          class="shrink-0 [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
        />
      </div>

      {/* Scrollable body: sessions + projects */}
      <div class="flex-1 min-h-0 overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Sessions */}
        <Show when={sidebarSessions().length > 0}>
          <For each={groups()}>
            {(group) => (
              <div class="mb-3">
                <div class={SECTION_LABEL}>{group.label}</div>
                <div class="mt-1 flex flex-col gap-px">
                  <For each={group.items}>
                    {(item) => {
                      const title = createMemo(() => sessionTitle(item.session.title) || item.session.id.slice(0, 8))
                      const isActive = () =>
                        item.session.id === activeSessionId() &&
                        pathKey(item.session.directory) === pathKey(activeDir())
                      const [menuOpen, setMenuOpen] = createSignal(false)
                      return (
                        <div
                          class={`group/chat ${ROW_BASE} h-8 gap-1 pl-3 pr-1`}
                          classList={{
                            "bg-v2-overlay-simple-overlay-hover text-v2-text-text-base": isActive() || menuOpen(),
                          }}
                        >
                          <button
                            type="button"
                            class="min-w-0 flex-1 h-full border-0 bg-transparent p-0 text-left text-inherit cursor-default focus-visible:outline-none"
                            onClick={() => openSession(item.session)}
                          >
                            <span class="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{title()}</span>
                          </button>
                          <DropdownMenu open={menuOpen()} onOpenChange={setMenuOpen} gutter={4} placement="bottom-end">
                            <DropdownMenu.Trigger
                              class="flex size-6 shrink-0 items-center justify-center rounded-[4px] border-0 bg-transparent text-v2-icon-icon-muted opacity-0 transition-opacity cursor-default hover:bg-v2-overlay-simple-overlay-hover group-hover/chat:opacity-100 focus-visible:opacity-100"
                              classList={{ "opacity-100": menuOpen() }}
                              aria-label={language.t("common.moreOptions")}
                              onClick={(event: MouseEvent) => event.stopPropagation()}
                            >
                              <IconV2 name="dots-horizontal" size="small" />
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content class="min-w-[160px]">
                                <DropdownMenu.Item onSelect={() => showRenameDialog(item)}>
                                  <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={() => archiveSession(item)}>
                                  <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item onSelect={() => showDeleteDialog(item)}>
                                  <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>

        {/* Projects */}
        <div class="mt-1">
          <div class={SECTION_LABEL}>{language.t("home.projects")}</div>
          <div class="mt-1 flex flex-col gap-px">
            <Show when={props.projects().length > 0}>
              <For each={props.projects()}>
                {(project) => {
                  const name = createMemo(() => displayName(project))
                  const isActive = () => pathKey(project.worktree) === pathKey(activeDir())
                  return (
                    <button
                      type="button"
                      class={`${ROW_BASE} h-8 gap-1.5 px-3`}
                      classList={{
                        "bg-v2-overlay-simple-overlay-hover text-v2-text-text-base": isActive(),
                      }}
                      onClick={() => openProject(project)}
                    >
                      <AvatarV2
                        fallback={name()}
                        src={undefined}
                        kind="org"
                        size="small"
                        {...getAvatarColors(project.icon?.color)}
                        class="size-4 shrink-0 rounded"
                      />
                      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{name()}</span>
                    </button>
                  )
                }}
              </For>
            </Show>
          </div>
          <DropdownMenu gutter={6} placement="bottom-start">
            <DropdownMenu.Trigger class={`${ROW_BASE} mt-1 h-8 w-full gap-1.5 px-3 text-v2-text-text-faint`}>
              <IconV2 name="folder-add-left" size="small" class="[&_[data-slot=icon-svg]]:text-v2-icon-icon-muted" />
              <span>{language.t("home.project.add")}</span>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="min-w-[210px]">
                <DropdownMenu.Group>
                  <DropdownMenu.GroupLabel>Open a project</DropdownMenu.GroupLabel>
                  <DropdownMenu.Item onSelect={() => props.onOpenProject()}>
                    <IconV2 name="folder-add-left" />
                    <DropdownMenu.ItemLabel>New project…</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => props.onQuickStart()}>
                    <IconV2 name="grid-plus" />
                    <DropdownMenu.ItemLabel>Quick start</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => props.onNoProject()}>
                    <IconV2 name="xmark-small" />
                    <DropdownMenu.ItemLabel>No project</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                </DropdownMenu.Group>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </div>

      {/* Footer */}
      <div class="shrink-0 flex items-center gap-1 px-2 py-2 border-t border-v2-border-border-weaker">
        <IconButtonV2
          variant="ghost-muted"
          size="large"
          icon={<IconV2 name="settings-gear" />}
          onClick={props.onOpenSettings}
          aria-label={language.t("sidebar.settings")}
          class="[&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
        />
        <IconButtonV2
          variant="ghost-muted"
          size="large"
          icon={<IconV2 name="help" />}
          onClick={props.onOpenHelp}
          aria-label={language.t("sidebar.help")}
          class="[&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
        />
      </div>
    </nav>
  )
}
