import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createSignal, onMount } from "solid-js"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { useEditorContext } from "@tui/context/editor"
import { useTheme } from "../context/theme"
import { RGBA } from "@opentui/core"

function TuiGoblinHeader(props: { theme: any }) {
  const skinColor = RGBA.fromInts(154, 219, 53)
  const shadowColor = RGBA.fromInts(120, 125, 135)
  const vestColor = RGBA.fromInts(130, 80, 223)
  const eyeColor = props.theme.backgroundElement
  const interiorWidth = 96
  const brandPanelWidth = 52

  // Goblin Mascot Head Only (8 rows high, 18 columns wide)
  const mascotGrid = [
    "......GGGGGG......",  // Row 0: Head top
    "....GGGGGGGGGG....",  // Row 1: Head mid-top
    "GG..GGGGGGGGGG..GG",  // Row 2: Ear tips & head
    ".GGGGGGGGGGGGGGGG.",  // Row 3: Ear body & head
    "..GGGGBBGGBBGGGG..",  // Row 4: Ears & eyes
    "..GGGGBBGGBBGGGG..",  // Row 5: Ears & eyes lower
    "....GGGGGGGGGG....",  // Row 6: Lower head
    "......GGGGGG......",  // Row 7: Neck/Chin
  ]

  const brandLines = [
    "",
    "",
    "CODEGOBLIN",
    "C O D E G O B L I N",
    "",
    "",
    "",
    "",
  ]

  function centerText(line: string, width: number) {
    const clipped = line.slice(0, width)
    const leftPadding = Math.floor((width - clipped.length) / 2)
    const rightPadding = width - clipped.length - leftPadding
    return `${" ".repeat(leftPadding)}${clipped}${" ".repeat(rightPadding)}`
  }

  function renderBrandRow(mascotRowIdx: number) {
    const line = centerText(brandLines[mascotRowIdx] ?? "", brandPanelWidth)
    return (
      <text fg={skinColor}>
        <b>{line}</b>
      </text>
    )
  }

  function renderMascotRow(rowIndex: number) {
    const row = mascotGrid[rowIndex] ?? ""
    const elements: JSX.Element[] = []
    for (const char of row) {
      if (char === "G") {
        elements.push(<text fg={skinColor}>██</text>)
      } else if (char === "P") {
        elements.push(<text fg={vestColor}>██</text>)
      } else if (char === "B") {
        elements.push(<text fg={eyeColor}>██</text>)
      } else {
        elements.push(<text>  </text>)
      }
    }
    return elements
  }

  const rows: JSX.Element[] = []
  const borderLeft = <text fg={shadowColor}>│</text>
  const borderRight = <text fg={shadowColor}>│</text>
  
  // Row 0: Top border (96 interior chars + 2 border chars = 98 chars wide)
  rows.push(
    <box flexDirection="row">
      <text fg={shadowColor}>┌</text>
      <text fg={shadowColor}>{"─".repeat(interiorWidth)}</text>
      <text fg={shadowColor}>┐</text>
    </box>
  )
  
  // Row 1: Empty padding (96 spaces)
  rows.push(
    <box flexDirection="row">
      {borderLeft}
      <text>{" ".repeat(interiorWidth)}</text>
      {borderRight}
    </box>
  )
  
  // Rows 2-9: Word + Mascot (mascot rows 0-7)
  for (let i = 0; i < 8; i++) {
    rows.push(
      <box flexDirection="row">
        {borderLeft}
        <text>  </text>
        {renderBrandRow(i)}
        <text>    </text>
        {renderMascotRow(i)}
        <text>  </text>
        {borderRight}
      </box>
    )
  }
  
  // Row 10: Bottom border
  rows.push(
    <box flexDirection="row">
      <text fg={shadowColor}>└</text>
      <text fg={shadowColor}>{"─".repeat(interiorWidth)}</text>
      <text fg={shadowColor}>┘</text>
    </box>
  )

  return (
    <box flexDirection="column" alignItems="center">
      {rows}
    </box>
  )
}

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
  const { theme } = useTheme()
  let sent = false

  onMount(() => {
    editor.clearSelection()
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
        <box height={2} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            <TuiGoblinHeader theme={theme} />
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
