import { createMemo, For, Show, type Accessor } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { DateTime } from "luxon"
import { base64Encode } from "@codegoblin/core/util/encode"
import { getFilename } from "@codegoblin/core/util/path"
import type { Session } from "@codegoblin/sdk/v2/client"
import { useGlobalSync } from "@/context/global-sync"
import { getAvatarColors, useLayout, type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { pathKey } from "@/utils/path-key"
import { sessionTitle } from "@/utils/session-title"
import { sortedRootSessions, displayName } from "@/pages/layout/helpers"
import { CodeGoblinLogoMark } from "@/components/codegoblin-logo"
import { Avatar as AvatarV2 } from "@codegoblin/ui/v2/components/avatar-v2.jsx"
import { IconButtonV2 } from "@codegoblin/ui/v2/components/icon-button-v2.jsx"
import { Icon as IconV2 } from "@codegoblin/ui/v2/components/icon.jsx"

const ROW_BASE =
  "flex min-w-0 w-full items-center rounded-[6px] border-0 bg-transparent text-left text-[13px] [font-weight:440] text-v2-text-text-muted transition-colors duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none cursor-default"
const SECTION_LABEL = "px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-v2-text-text-faint select-none"

const SESSION_LIMIT = 20

type SidebarSession = { session: Session; project: LocalProject | undefined }

export function ThreePaneSidebar(props: {
  projects: Accessor<LocalProject[]>
  currentDir: Accessor<string>
  onNewChat: () => void
  onOpenProject: () => void
  onOpenSettings: () => void
  onOpenHelp: () => void
}) {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const server = useServer()
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams()

  const projectByWorktree = createMemo(
    () => new Map(props.projects().map((p) => [pathKey(p.worktree), p])),
  )

  const sidebarSessions = createMemo(() => {
    const now = Date.now()
    const seen = new Set<string>()
    const results: SidebarSession[] = []

    for (const project of props.projects()) {
      const [store] = globalSync.child(project.worktree, { bootstrap: false })
      for (const session of sortedRootSessions(store, now)) {
        const key = `${pathKey(session.directory)}:${session.id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({
          session,
          project: projectByWorktree().get(pathKey(session.directory)) ??
            projectByWorktree().get(pathKey(project.worktree)),
        })
      }
    }

    return results
      .sort(
        (a, b) =>
          (b.session.time.updated ?? b.session.time.created) -
          (a.session.time.updated ?? a.session.time.created),
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
                    {({ session }) => {
                      const title = createMemo(
                        () => sessionTitle(session.title) || session.id.slice(0, 8),
                      )
                      const isActive = () =>
                        session.id === activeSessionId() &&
                        pathKey(session.directory) === pathKey(activeDir())
                      return (
                        <button
                          type="button"
                          class={`${ROW_BASE} h-8 gap-2 px-3`}
                          classList={{
                            "bg-v2-overlay-simple-overlay-hover text-v2-text-text-base": isActive(),
                          }}
                          onClick={() => openSession(session)}
                        >
                          <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                            {title()}
                          </span>
                        </button>
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
            <Show
              when={props.projects().length > 0}
              fallback={
                <button
                  type="button"
                  class={`${ROW_BASE} h-8 gap-1.5 px-3 text-v2-text-text-faint`}
                  onClick={props.onOpenProject}
                >
                  <IconV2 name="folder-add-left" size="small" class="[&_[data-slot=icon-svg]]:text-v2-icon-icon-muted" />
                  <span>{language.t("home.project.add")}</span>
                </button>
              }
            >
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
                      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {name()}
                      </span>
                    </button>
                  )
                }}
              </For>
            </Show>
          </div>
          <button
            type="button"
            class={`${ROW_BASE} mt-1 h-8 gap-1.5 px-3 text-v2-text-text-faint`}
            onClick={props.onOpenProject}
          >
            <IconV2 name="folder-add-left" size="small" class="[&_[data-slot=icon-svg]]:text-v2-icon-icon-muted" />
            <span>{language.t("home.project.add")}</span>
          </button>
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
