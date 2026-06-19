import type { Session } from "@codegoblin/sdk/v2/client"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@codegoblin/ui/button"
import { Spinner } from "@codegoblin/ui/spinner"
import { Avatar as AvatarV2 } from "@codegoblin/ui/v2/components/avatar-v2.jsx"
import { ButtonV2 } from "@codegoblin/ui/v2/components/button-v2.jsx"
import { Icon as IconV2 } from "@codegoblin/ui/v2/components/icon.jsx"
import { IconButtonV2 } from "@codegoblin/ui/v2/components/icon-button-v2.jsx"
import { getAvatarColors, useLayout, type LocalProject } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@codegoblin/core/util/encode"
import { Icon } from "@codegoblin/ui/icon"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@codegoblin/ui/context/dialog"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useServer } from "@/context/server"
import { SDKProvider } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { displayName, getProjectAvatarSource, projectForSession, sortedRootSessions } from "@/pages/layout/helpers"
import { pathKeysEqual } from "@/utils/path-key"
import { getFilename } from "@codegoblin/core/util/path"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { messageAgentColor } from "@/utils/agent"
import { sessionPermissionRequest } from "@/pages/session/composer/session-request-tree"
import { CodeGoblinLogoMark } from "@/components/codegoblin-logo"
import { showToast } from "@codegoblin/ui/toast"

const USE_HOME_DESIGN = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"
const HOME_SESSION_LIMIT = 15
const HOME_ROW =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] border-0 bg-transparent text-left [font-weight:530] text-v2-text-text-muted transition-colors duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW} h-8 gap-1.5 px-3 [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap`
const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"

type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

export default function Home() {
  if (USE_HOME_DESIGN) return <HomeDesign />
  return <LegacyHome />
}

function HomeDesign() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const [state, setState] = createStore({ search: "", project: undefined as string | undefined })

  const projects = createMemo(() => layout.projects.list())
  const selectedProject = createMemo(
    () => projects().find((project) => project.worktree === state.project) ?? projects()[0],
  )
  const projectDirectories = createMemo(() => {
    const dirs = new Set<string>()
    for (const project of projects()) {
      dirs.add(project.worktree)
      for (const sandbox of project.sandboxes ?? []) dirs.add(sandbox)
    }
    return [...dirs]
  })
  const search = createMemo(() => state.search.trim())
  const sessionLoad = useQuery(() => ({
    queryKey: ["home", "sessions", ...projectDirectories()] as const,
    queryFn: async () => {
      await Promise.all(projectDirectories().map((directory) => sync.project.loadSessions(directory)))
      return null
    },
  }))

  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const records = createMemo(() =>
    [
      ...new Map(
        projectDirectories()
          .flatMap((directory) => sortedRootSessions(sync.child(directory, { bootstrap: false })[0], Date.now()))
          .map((session) => [`${pathKey(session.directory)}:${session.id}`, session] as const),
      ).values(),
    ]
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .flatMap((session) => {
        const project = projectForSession(session, projects(), projectByID())
        if (!project) return []
        return {
          session,
          project,
          projectName: displayName(project),
        }
      })
      .filter((record) => {
        const value = search().toLowerCase()
        if (!value) return true
        return `${record.session.title} ${record.projectName}`.toLowerCase().includes(value)
      })
      .slice(0, HOME_SESSION_LIMIT),
  )
  const groups = createMemo(() => groupSessions(records(), language))

  function selectProject(directory: string) {
    if (!projects().some((project) => pathKeysEqual(project.worktree, directory))) return
    setState("project", directory)
  }

  function addProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    setState("project", directory)
  }

  function openNewSession() {
    const project = selectedProject()
    if (!project) {
      void chooseProject()
      return
    }
    layout.projects.open(project.worktree)
    server.projects.touch(project.worktree)
    navigate(`/${base64Encode(project.worktree)}/session`)
  }

  function openSession(session: Session) {
    const project = projectForSession(session, projects(), projectByID())
    layout.projects.open(project?.worktree ?? session.directory)
    server.projects.touch(project?.worktree ?? session.directory)
    navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        result.forEach(addProject)
        if (result[0]) setState("project", result[0])
        return
      }
      if (result) addProject(result)
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
      return
    }

    dialog.show(
      () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
      () => resolve(null),
    )
  }

  function openSettings() {
    void import("@/components/dialog-settings").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }

  function openMemory() {
    const directory = selectedProject()?.worktree ?? projects()[0]?.worktree
    if (!directory) {
      showToast({
        title: "Add a project first",
        description: "Memory is scoped to a project folder. Choose one to continue.",
      })
      void chooseProject()
      return
    }
    void import("@/components/dialog-memory").then((x) => {
      dialog.show(() => (
        <SDKProvider directory={directory}>
          <x.DialogMemory />
        </SDKProvider>
      ))
    })
  }

  function openMarket() {
    const directory = selectedProject()?.worktree ?? projects()[0]?.worktree
    if (!directory) {
      showToast({
        title: "Add a project first",
        description: "Market installs MCP servers into a project config. Choose a folder to continue.",
      })
      void chooseProject()
      return
    }
    void import("@/components/dialog-market").then((x) => {
      dialog.show(() => (
        <SDKProvider directory={directory}>
          <x.DialogMarket />
        </SDKProvider>
      ))
    })
  }

  return (
    <div data-cg-home class="relative flex h-full w-full min-h-0 overflow-hidden">
      <div class="pointer-events-none absolute right-[-48px] top-9 z-[1] opacity-[0.05]">
        <GrikGlyph size={480} />
      </div>
      <span class="cg-ember" style="left:23%;bottom:13%;animation-duration:7.5s" />
      <span class="cg-ember" style="left:47%;bottom:6%;animation-duration:9s;animation-delay:2.5s" />
      <span class="cg-ember" style="left:72%;bottom:15%;animation-duration:8s;animation-delay:4s" />
      <span class="cg-ember" style="left:88%;bottom:9%;animation-duration:10.5s;animation-delay:1.5s" />
      <span class="cg-ember" style="left:35%;bottom:20%;animation-duration:11s;animation-delay:5.5s" />
      <HomeRail
        openNewSession={openNewSession}
        openSettings={openSettings}
        openHelp={() => platform.openLink("https://github.com/shawnisikli/CodeGoblin/issues")}
      />
      <div class="relative z-[2] min-w-0 flex-1 overflow-y-auto px-7 pb-16 pt-7">
        <div class="mx-auto flex w-full max-w-[1180px] flex-col gap-7">
          <CodeGoblinWebHero openMemory={openMemory} openMarket={openMarket} openNewSession={openNewSession} />
          <div class="grid min-w-0 items-start gap-7 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section class="flex min-w-0 flex-col" aria-label={language.t("sidebar.project.recentSessions")}>
              <div class="mb-3 flex items-center justify-between px-1">
                <div class="text-12-medium uppercase tracking-[0.16em] text-[#5f7a62]">the dig log</div>
                <button type="button" class="cg-stone-btn text-12-medium" onClick={openNewSession}>
                  <Icon name="edit" size="small" />
                  new dig
                </button>
              </div>
              <HomeSessionSearch
                value={state.search}
                placeholder={language.t("home.sessions.search.placeholder")}
                onInput={(value) => setState("search", value)}
              />
              <div class="mt-4 flex flex-col gap-6">
                <Show when={!sessionLoad.isLoading} fallback={<HomeSessionSkeleton label={language.t("common.loading")} />}>
                  <Show
                    when={groups().length > 0}
                    fallback={
                      <div class="cg-panel mt-1 flex flex-col items-center justify-center gap-4 px-6 py-14 text-center">
                        <CodeGoblinLogoMark size="md" />
                        <div>
                          <div class="text-15-medium text-[#eafff0]">the hoard&rsquo;s empty</div>
                          <div class="mt-1 text-13-regular text-[#7f9a82]">
                            no sessions yet &mdash; grik&rsquo;s lantern is lit. start your first dig.
                          </div>
                        </div>
                        <button type="button" class="cg-gem-btn text-13-medium" onClick={openNewSession}>
                          <Icon name="edit" size="small" />
                          new dig
                        </button>
                      </div>
                    }
                  >
                    <For each={groups()}>
                      {(group, index) => (
                        <div class="flex min-w-0 flex-col gap-3">
                          <HomeSessionGroupHeader
                            title={group.title}
                            onNewSession={index() === 0 ? openNewSession : undefined}
                          />
                          <div class="flex min-w-0 flex-col gap-1">
                            <For each={group.sessions}>
                              {(record) => <HomeSessionRow record={record} openSession={openSession} />}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </Show>
                </Show>
              </div>
            </section>
            <HomeTunnels
              projects={projects()}
              selected={selectedProject()?.worktree}
              selectProject={selectProject}
              chooseProject={() => void chooseProject()}
              language={language}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function CodeGoblinWebHero(props: { openMemory: () => void; openMarket: () => void; openNewSession: () => void }) {
  const hour = new Date().getHours()
  const partOfDay = hour < 5 ? "late" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"
  const creedDot = <span class="text-[#33502f]">·</span>

  return (
    <div class="cg-panel relative overflow-hidden px-8 py-7">
      <div class="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-[#f5c84b] opacity-[0.05] blur-[70px]" />
      <div class="pointer-events-none absolute -left-10 top-1/2 h-44 w-44 -translate-y-1/2 rounded-full bg-[#9ADB35] opacity-[0.06] blur-[60px]" />
      <div class="relative flex flex-wrap items-end justify-between gap-6">
        <div class="min-w-0">
          <div class="text-12-medium uppercase tracking-[0.18em] text-[#5f7a62]">good {partOfDay}, goblin</div>
          <div class="mt-1.5 text-[34px] font-bold leading-[1.05] text-[#eafff0]">what are we digging up?</div>
          <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-12-medium text-[#6f8a72]">
            <span class="inline-flex items-center gap-1.5">
              <span class="size-1.5 rounded-full bg-[#9ADB35] shadow-[0_0_6px_#9ADB35]" />
              nothing leaves the cave
            </span>
            {creedDot}
            <span>BYOK intact</span>
            {creedDot}
            <span>images &rarr; codegoblin-output/</span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2.5">
          <button type="button" class="cg-stone-btn text-13-medium" onClick={() => props.openMemory()}>
            memory
          </button>
          <button type="button" class="cg-stone-btn text-13-medium" onClick={() => props.openMarket()}>
            market
          </button>
          <button type="button" class="cg-gem-btn text-13-medium" onClick={() => props.openNewSession()}>
            <Icon name="edit" size="small" />
            new dig
          </button>
        </div>
      </div>
    </div>
  )
}

function GrikGlyph(props: { size?: number; class?: string }) {
  const s = props.size ?? 64
  return (
    <svg width={s} height={s} viewBox="0 0 512 512" class={props.class} aria-hidden="true">
      <path
        d="M183 110h146l24 64 86 20c15 4 23 21 17 35l-39 87c-5 12-18 18-30 15l-57-13-20 84c-3 13-15 22-29 20l-87-10c-10-1-19-8-23-18l-31-73-49-35c-7-5-12-13-13-22l-10-87c-2-14 8-27 22-29l78-10 19-58Z"
        fill="#9ADB35"
      />
      <path
        d="M177 242c0-10 8-18 18-18h36c10 0 18 8 18 18v51c0 11-9 20-20 19l-35-3c-10-1-17-9-17-19v-48Zm161-18c10 0 18 8 18 18v42c0 10-7 18-17 19l-31 4c-11 1-20-7-20-18v-47c0-10 8-18 18-18h32Z"
        fill="#040805"
      />
    </svg>
  )
}

function HomeRail(props: { openNewSession: () => void; openSettings: () => void; openHelp: () => void }) {
  return (
    <div class="relative z-[3] flex w-[72px] shrink-0 flex-col items-center gap-2.5 border-r border-[#122a16] bg-[#050a06]/70 py-5 backdrop-blur-sm">
      <CodeGoblinLogoMark size="md" />
      <div class="my-1 h-px w-7 bg-[#163019]" />
      <button type="button" class="cg-rail-btn" data-active onClick={props.openNewSession} aria-label="new dig" title="new dig">
        <Icon name="edit" size="small" />
      </button>
      <div class="mt-auto flex flex-col items-center gap-2.5">
        <button type="button" class="cg-rail-btn" onClick={props.openSettings} aria-label="settings" title="settings">
          <IconV2 name="settings-gear" size="small" />
        </button>
        <button type="button" class="cg-rail-btn" onClick={props.openHelp} aria-label="help" title="help">
          <IconV2 name="help" size="small" />
        </button>
      </div>
    </div>
  )
}

function HomeTunnels(props: {
  projects: LocalProject[]
  selected?: string
  selectProject: (directory: string) => void
  chooseProject: () => void
  language: ReturnType<typeof useLanguage>
}) {
  return (
    <aside class="cg-panel flex min-w-0 flex-col gap-1 p-3" aria-label={props.language.t("home.projects")}>
      <div class="flex items-center justify-between px-2 pb-1.5 pt-1">
        <div class="text-12-medium uppercase tracking-[0.16em] text-[#5f7a62]">tunnels</div>
        <button
          type="button"
          class="grid size-7 place-items-center rounded-lg border border-[#234a27] bg-[#0c170e] text-[#6f8a72] transition-colors duration-[120ms] hover:border-[#2b6d31] hover:text-[#cfe6d1]"
          onClick={props.chooseProject}
          aria-label={props.language.t("home.project.add")}
          title="open a tunnel"
        >
          <IconV2 name="folder-add-left" size="small" />
        </button>
      </div>
      <div class="flex max-h-[min(560px,calc(100vh_-_320px))] min-w-0 flex-col gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Show
          when={props.projects.length > 0}
          fallback={
            <button
              type="button"
              class="cg-ledger-row flex items-center gap-2.5 px-3 py-2.5 text-left text-13-regular text-[#7f9a82]"
              onClick={props.chooseProject}
            >
              <span class="grid size-5 shrink-0 place-items-center rounded-md border border-dashed border-[#2b6d31] text-[11px] text-[#9ADB35]">
                +
              </span>
              open a tunnel
            </button>
          }
        >
          <For each={props.projects}>
            {(project) => (
              <button
                type="button"
                data-component="home-project-row"
                class="cg-ledger-row flex items-center gap-2.5 px-3 py-2 text-left"
                classList={{ "bg-[#0e1a10]": props.selected === project.worktree }}
                data-selected={props.selected === project.worktree ? "" : undefined}
                aria-current={props.selected === project.worktree ? "page" : undefined}
                onClick={() => props.selectProject(project.worktree)}
              >
                <span
                  class="grid size-5 shrink-0 place-items-center rounded-md border border-[#234a27] bg-[#0c170e] text-[11px] leading-none"
                  classList={{ "text-[#9ADB35]": props.selected === project.worktree, "text-[#3b6d2b]": props.selected !== project.worktree }}
                >
                  &#9670;
                </span>
                <span class="min-w-0 truncate text-13-medium text-[#cfe6d1]">{displayName(project)}</span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </aside>
  )
}

function HomeProjectAvatar(props: { project: LocalProject }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <AvatarV2
      fallback={name()}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      kind="org"
      size="small"
      {...getAvatarColors(props.project.icon?.color)}
      class="size-4 rounded"
    />
  )
}

function HomeSessionSearch(props: { value: string; placeholder: string; onInput: (value: string) => void }) {
  return (
    <label class="ml-4 flex h-9 w-[calc(100%_-_48px)] sticky top-0 inset-x-0 items-center gap-2 rounded-[6px] bg-v2-background-bg-deep px-3 py-1 text-v2-icon-icon-muted transition-[background-color,box-shadow] duration-[120ms] ease-in-out focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_0.5px_var(--v2-border-border-focus),var(--v2-elevation-raised)]">
      <IconV2 name="magnifying-glass" size="small" />
      <input
        class="min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  )
}

function HomeSessionGroupHeader(props: { title: string; onNewSession?: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex h-7 min-w-0 items-center justify-between px-4">
      <div class={HOME_SECTION_LABEL}>{props.title}</div>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2
            data-action="home-new-session"
            variant="ghost"
            size="normal"
            icon="edit"
            class="h-7 px-2 text-v2-text-text-muted [font-weight:530]"
            onClick={onNewSession()}
          >
            {language.t("command.session.new")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionRow(props: { record: HomeSessionRecord; openSession: (session: Session) => void }) {
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()
  const [sessionStore] = globalSync.child(props.record.session.directory, { bootstrap: false })
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)
  const unseenCount = createMemo(() => notification.session.unseenCount(props.record.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.record.session.id))
  const hasPermissions = createMemo(
    () =>
      !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.record.session.id, (item) => {
        return !permission.autoResponds(item, props.record.session.directory)
      }),
  )
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return sessionStore.session_working(props.record.session.id)
  })
  const tint = createMemo(() => messageAgentColor(sessionStore.message[props.record.session.id], sessionStore.agent))
  const showStatus = createMemo(() => isWorking() || hasPermissions() || hasError() || unseenCount() > 0)

  return (
    <button
      type="button"
      data-component="home-session-row"
      class={`${HOME_ROW} h-10 gap-2 px-6 py-3 pl-4`}
      onClick={() => props.openSession(props.record.session)}
    >
      <Show when={showStatus()}>
        <div
          class="flex size-4 shrink-0 items-center justify-center"
          style={{ color: tint() ?? "var(--icon-interactive-base)" }}
        >
          <Switch>
            <Match when={isWorking()}>
              <Spinner class="size-[15px]" />
            </Match>
            <Match when={hasPermissions()}>
              <div class="size-1.5 rounded-full bg-surface-warning-strong" />
            </Match>
            <Match when={hasError()}>
              <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
            </Match>
            <Match when={unseenCount() > 0}>
              <div class="size-1.5 rounded-full bg-text-interactive-base" />
            </Match>
          </Switch>
        </div>
      </Show>
      <span
        class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] ${props.record.projectName ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
      >
        {title()}
      </span>
      <Show when={props.record.projectName}>
        <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]">
          {props.record.projectName}
        </span>
      </Show>
    </button>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between px-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}</For>
      </div>
    </div>
  )
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")

  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

function LegacyHome() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const homedir = createMemo(() => sync.data.path.home)
  const recent = createMemo(() => {
    return sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  const serverDotClass = createMemo(() => {
    const healthy = server.healthy()
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  function openProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory)
        }
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <div class="flex flex-col items-center gap-3 opacity-90">
        <CodeGoblinLogoMark size="md" />
        <div class="text-28-bold text-text-strong">CodeGoblin</div>
      </div>
      <Button
        size="large"
        variant="ghost"
        class="mt-4 mx-auto text-14-regular text-text-weak"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div
          classList={{
            "size-2 rounded-full": true,
            [serverDotClass()]: true,
          }}
        />
        {server.name}
      </Button>
      <Switch>
        <Match when={sync.data.project.length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <div class="text-14-regular text-text-weak">
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={!sync.ready}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
            <Button class="px-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <Button class="px-3 mt-1" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
