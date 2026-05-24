import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { useEditorContext } from "@tui/context/editor"
import { useTheme } from "../context/theme"
import { CodeGoblinBrand } from "@/codegoblin/brand"
import { CodeGoblinImageCommand } from "@/codegoblin/image-command"
import { useProject } from "@tui/context/project"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const project = useProject()
  const { theme } = useTheme()
  const [frame, setFrame] = createSignal(0)
  const [usage, setUsage] = createSignal("Loading local usage...")
  let sent = false

  onMount(() => {
    editor.clearSelection()
    const timer = setInterval(() => setFrame((value) => (value + 1) % CodeGoblinBrand.mascotFrames.length), 550)
    void CodeGoblinImageCommand.usageSummary(project.instance.directory() || process.cwd()).then(setUsage).catch(() => {
      setUsage("Local usage will appear after the first generated image.")
    })
    onCleanup(() => clearInterval(timer))
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            <box alignItems="center">
              <Logo idle />
              <box height={1} />
              <text fg={theme.primary}>{CodeGoblinBrand.product}</text>
              <text fg={theme.textMuted}>{CodeGoblinBrand.tagline}</text>
              <box height={1} />
              <text fg={theme.text}>{CodeGoblinBrand.mascotFrames[frame()]}</text>
              <text fg={theme.textMuted}>Image models save files under codegoblin-output/images.</text>
              <text fg={theme.textMuted}>{usage().split("\n")[0]}</text>
            </box>
          </TuiPluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={75} zIndex={1000} paddingTop={1} flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<TuiPluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
          </TuiPluginRuntime.Slot>
        </box>
        <TuiPluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
