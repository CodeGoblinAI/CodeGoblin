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
import { CodeGoblinLogoMark } from "@/components/codegoblin-logo"

const MAIN_WORKTREE = "main"

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
    <div data-component="session-new-design" data-cg-session class="relative size-full overflow-hidden">
      <div class="pointer-events-none absolute -right-16 top-12 z-[1] opacity-[0.05]">
        <GrikGlyph size={460} />
      </div>
      <span class="cg-ember" style="left:24%;bottom:14%;animation-duration:8s" />
      <span class="cg-ember" style="left:60%;bottom:9%;animation-duration:9.5s;animation-delay:3s" />
      <span class="cg-ember" style="left:80%;bottom:18%;animation-duration:10.5s;animation-delay:1.5s" />
      <div class="absolute inset-x-0 top-[18%] z-[2] flex justify-center px-6">
        <div class="w-full max-w-[720px]">
          <div class="flex flex-col items-center gap-3 text-center">
            <CodeGoblinLogoMark size="lg" />
            <div class="cg-display text-[42px] leading-tight text-[#eafff0]">what are we digging up?</div>
            <div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12px] font-medium text-[#6f8a72]">
              <span class="inline-flex items-center gap-1.5">
                <span class="size-1.5 rounded-full bg-[#9ADB35] shadow-[0_0_6px_#9ADB35]" />
                nothing leaves the cave
              </span>
              <span class="text-[#33502f]">&middot;</span>
              <span>BYOK intact</span>
              <span class="text-[#33502f]">&middot;</span>
              <span>images &rarr; codegoblin-output/</span>
            </div>
          </div>
          <div class="cg-panel mt-8 p-2.5">
            <div class="mb-1.5 flex items-center gap-1.5 px-2 pt-0.5 text-[11px] font-medium uppercase tracking-[0.16em] text-[#5f7a62]">
              <span class="text-[#f5c84b]">&#9670;</span> the pickaxe
            </div>
            {props.children}
            <div class="mt-2 flex h-7 items-center gap-0 pl-2">
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
      </div>
    </div>
  )
}
