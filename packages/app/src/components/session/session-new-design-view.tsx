import type { JSX } from "solid-js"
import { createMemo } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useGlobalSync } from "@/context/global-sync"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { base64Encode } from "@codegoblin/core/util/encode"
import { getFilename } from "@codegoblin/core/util/path"
import { Icon } from "@codegoblin/ui/icon"
import { Select } from "@codegoblin/ui/select"

const MAIN_WORKTREE = "main"

export function NewSessionDesignView(props: { worktree: string; children: JSX.Element }) {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const navigate = useNavigate()
  const sdk = useSDK()
  const server = useServer()
  const sync = useSync()

  const projectRoot = createMemo(() => sync.project?.worktree ?? sdk.directory)
  const projects = createMemo(() => {
    const roots = globalSync.data.project.map((project) => project.worktree)
    if (roots.includes(projectRoot())) return roots
    return [projectRoot(), ...roots]
  })
  const branch = createMemo(() => sync.data.vcs?.branch ?? MAIN_WORKTREE)

  const openProject = (directory: string | undefined) => {
    if (!directory) return
    if (directory === projectRoot()) return
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}/session`)
  }

  return (
    <div data-component="session-new-design" data-cg-session class="size-full min-h-0 overflow-auto">
      <div class="mx-auto flex min-h-full w-full max-w-[680px] flex-col px-6 py-[clamp(4rem,12vh,9rem)]">
        <h1 class="mb-4 text-center text-[22px] font-semibold text-v2-text-text-base">What should we work on?</h1>
        {props.children}
        <div class="mt-2 flex h-7 items-center gap-2 pl-1">
          <Select
            size="normal"
            variant="ghost"
            options={projects()}
            current={projectRoot()}
            label={getFilename}
            onSelect={openProject}
            class="max-w-[203px] justify-start text-text-base [&_[data-component=icon]]:text-v2-icon-icon-muted"
            valueClass="truncate text-[length:13px] font-[440] text-v2-text-text-faint"
          />
          <div class="relative">
            <div class="pointer-events-none absolute left-2 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center">
              <Icon name="branch" size="small" />
            </div>
            <Select
              size="normal"
              variant="ghost"
              options={[branch()]}
              current={branch()}
              class="max-w-[240px] justify-start text-text-base [&_[data-component=icon]]:text-v2-icon-icon-muted"
              valueClass="truncate pl-5 font-[440] text-v2-text-text-faint"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
