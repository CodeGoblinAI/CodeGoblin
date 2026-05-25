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
import { RGBA, TextAttributes } from "@opentui/core"

function TuiGoblinHeader(props: { theme: any }) {
  const skinColor = RGBA.fromInts(154, 219, 53)
  const shadowColor = RGBA.fromInts(120, 125, 135)
  const vestColor = RGBA.fromInts(130, 80, 223)
  const eyeColor = props.theme.backgroundElement

  interface TextChunk {
    text: string
    fg?: any
    attributes?: number
  }

  interface HeaderVariant {
    id: string
    name: string
    brandPanelWidth: number
    rows: TextChunk[][]
    mascotGrid?: string[]
  }

  const chunk = (text: string, fg?: any, attributes?: number): TextChunk => ({ text, fg, attributes })
  const row = (...chunks: TextChunk[]) => chunks
  const center = (text: string, width: number) => {
    const clipped = text.slice(0, width)
    const left = Math.floor((width - clipped.length) / 2)
    return `${" ".repeat(left)}${clipped}`
  }

  // Goblin Mascot Head Only variants (8 rows high). Renderer pads rows so borders stay aligned.
  const baseMascotGrid = [
    "......GGGGGG......",  // Row 0: Head top
    "....GGGGGGGGGG....",  // Row 1: Head mid-top
    "GG..GGGGGGGGGG..GG",  // Row 2: Ear tips & head
    ".GGGGGGGGGGGGGGGG.",  // Row 3: Ear body & head
    "..GGGGBBGGBBGGGG..",  // Row 4: Ears & eyes
    "..GGGGBBGGBBGGGG..",  // Row 5: Ears & eyes lower
    "....GGGGGGGGGG....",  // Row 6: Lower head
    "......GGGGGG......",  // Row 7: Neck/Chin
  ]

  const cheekMascotGrid = [
    "......GGGGGG......",
    "....GGGGGGGGGG....",
    "GG..GGGGGGGGGG..GG",
    ".GGGGGGGGGGGGGGGG.",
    "..GGGGBBGGBBGGGG..",
    "..GGGPBBGGBBPGGG..",
    "....GGGGGGGGGG....",
    "......GGGGGG......",
  ]

  const narrowMascotGrid = [
    ".....GGGGGG.....",
    "...GGGGGGGGGG...",
    "G..GGGGGGGGGG..G",
    ".GGGGGGGGGGGGGG.",
    "..GGGBBGGBBGGG..",
    "..GGGBBGGBBGGG..",
    "....GGGGGGGG....",
    ".....GGGGGG.....",
  ]

  const headerVariants: HeaderVariant[] = [
    {
      id: "01",
      name: "HUD compact",
      brandPanelWidth: 60,
      mascotGrid: baseMascotGrid,
      rows: [
        [],
        row(chunk("  "), chunk("●", skinColor), chunk("  SYSTEM ACTIVE  //  TUI CORE INTERFACE")),
        row(chunk("  "), chunk("C O D E G O B L I N", skinColor, TextAttributes.BOLD)),
        [],
        [],
        row(chunk("  "), chunk("─".repeat(45), shadowColor)),
        row(chunk("  "), chunk("Your local AI goblin for code, images, and agents.", props.theme.text)),
        row(chunk("  "), chunk("Type "), chunk("/help", props.theme.primary, TextAttributes.BOLD), chunk(" to see all available commands.")),
      ],
    },
    {
      id: "02",
      name: "Centered wordmark",
      brandPanelWidth: 56,
      mascotGrid: baseMascotGrid,
      rows: [
        [],
        row(chunk(center("CODEGOBLIN", 56), skinColor, TextAttributes.BOLD)),
        row(chunk(center("C O D E G O B L I N", 56), skinColor)),
        [],
        row(chunk(center("local ai goblin shell", 56), props.theme.textMuted)),
        row(chunk(center("────────────", 56), shadowColor)),
        row(chunk(center("/help  ·  tab agents  ·  ctrl+p commands", 56), props.theme.textMuted)),
        [],
      ],
    },
    {
      id: "03",
      name: "Ultra wide tracking",
      brandPanelWidth: 64,
      mascotGrid: baseMascotGrid,
      rows: [
        [],
        row(chunk("  HEADER VARIANT 03  //  WIDE TRACKING", shadowColor)),
        row(chunk("  C   O   D   E   G   O   B   L   I   N", skinColor, TextAttributes.BOLD)),
        [],
        row(chunk("  clean native letters, no block wordmark", props.theme.textMuted)),
        row(chunk("  "), chunk("─".repeat(50), shadowColor)),
        row(chunk("  if this reads best, use as the safe default", props.theme.text)),
        [],
      ],
    },
    {
      id: "04",
      name: "Stacked CODE / GOBLIN",
      brandPanelWidth: 54,
      mascotGrid: cheekMascotGrid,
      rows: [
        [],
        row(chunk(center("C  O  D  E", 54), skinColor, TextAttributes.BOLD)),
        row(chunk(center("G  O  B  L  I  N", 54), skinColor, TextAttributes.BOLD)),
        [],
        row(chunk(center("two-line logo, extra breathing room", 54), props.theme.textMuted)),
        row(chunk(center("──────────────", 54), shadowColor)),
        row(chunk(center("head-only mascot with cheek pixels", 54), props.theme.text)),
        [],
      ],
    },
    {
      id: "05",
      name: "Badge frame",
      brandPanelWidth: 58,
      mascotGrid: narrowMascotGrid,
      rows: [
        [],
        row(chunk(center("┌────────────────────────────┐", 58), shadowColor)),
        row(chunk(center("│        CODEGOBLIN          │", 58), skinColor, TextAttributes.BOLD)),
        row(chunk(center("│   local code · image ai    │", 58), props.theme.textMuted)),
        row(chunk(center("└────────────────────────────┘", 58), shadowColor)),
        [],
        row(chunk(center("compact badge + narrower goblin", 58), props.theme.text)),
        [],
      ],
    },
    {
      id: "06",
      name: "Terminal prompt",
      brandPanelWidth: 60,
      mascotGrid: baseMascotGrid,
      rows: [
        [],
        row(chunk("  $ ", props.theme.primary, TextAttributes.BOLD), chunk("codegoblin", skinColor, TextAttributes.BOLD), chunk(" --ready", props.theme.textMuted)),
        row(chunk("  > ", shadowColor), chunk("C O D E G O B L I N", skinColor, TextAttributes.BOLD)),
        [],
        row(chunk("  mode: local tui    provider: selected model", props.theme.textMuted)),
        row(chunk("  output: codegoblin-output/images", props.theme.textMuted)),
        row(chunk("  "), chunk("─".repeat(42), shadowColor)),
        row(chunk("  goblin ready. type /help for commands.", props.theme.text)),
      ],
    },
    {
      id: "07",
      name: "Dot matrix",
      brandPanelWidth: 62,
      mascotGrid: cheekMascotGrid,
      rows: [
        row(chunk(center("● ● ● ● ● ● ● ● ● ●", 62), skinColor)),
        row(chunk(center("C · O · D · E · G · O · B · L · I · N", 62), skinColor, TextAttributes.BOLD)),
        row(chunk(center("● ● ● ● ● ● ● ● ● ●", 62), skinColor)),
        [],
        row(chunk(center("dot-matrix feel without fragile block letters", 62), props.theme.textMuted)),
        row(chunk(center("────────────────────────", 62), shadowColor)),
        row(chunk(center("variant 07", 62), props.theme.textMuted)),
        [],
      ],
    },
    {
      id: "08",
      name: "Micro pixel block",
      brandPanelWidth: 60,
      mascotGrid: baseMascotGrid,
      rows: [
        [],
        row(chunk("   ███  ███  ██   ███  ███  ███  ██   █    ███  █ █", skinColor)),
        row(chunk("   █    █ █  █ █  ██   █    █ █  ██   █     █   ███", skinColor)),
        row(chunk("   ███  ███  ██   ███  ███  ███  ██   ███  ███  █ █", skinColor)),
        [],
        row(chunk(center("micro 3-row block test", 60), props.theme.textMuted)),
        row(chunk(center("CODEGOBLIN", 60), skinColor, TextAttributes.BOLD)),
        [],
      ],
    },
    {
      id: "09",
      name: "Split pixel blocks",
      brandPanelWidth: 64,
      mascotGrid: narrowMascotGrid,
      rows: [
        row(chunk(center("████  ████  ███   █████", 64), skinColor)),
        row(chunk(center("█     █  █  █  █  ███", 64), skinColor)),
        row(chunk(center("████  ████  ███   █████", 64), skinColor)),
        [],
        row(chunk(center("████  ████  ███   █     ███  █  █", 64), skinColor)),
        row(chunk(center("█     █  █  █  █  █      █   ██ █", 64), skinColor)),
        row(chunk(center("████  ████  ███   ████  ███  █ ██", 64), skinColor)),
        row(chunk(center("CODE / GOBLIN split block experiment", 64), props.theme.textMuted)),
      ],
    },
    {
      id: "10",
      name: "Mascot-first card",
      brandPanelWidth: 52,
      mascotGrid: cheekMascotGrid,
      rows: [
        [],
        row(chunk(center("CODEGOBLIN", 52), skinColor, TextAttributes.BOLD)),
        row(chunk(center("C O D E  ::  G O B L I N", 52), skinColor)),
        row(chunk(center("small text, bigger visual weight on mascot", 52), props.theme.textMuted)),
        [],
        row(chunk(center("local ai · code · images · agents", 52), props.theme.text)),
        row(chunk(center("──────────────", 52), shadowColor)),
        row(chunk(center("variant 10", 52), props.theme.textMuted)),
      ],
    },
  ]

  function normalizeVariantId(value: string | undefined) {
    const cleaned = value?.trim().replace(/^v/i, "")
    const numeric = Number(cleaned)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 10) return String(numeric).padStart(2, "0")
    return "01"
  }

  const selectedVariantId = normalizeVariantId(process.env.CODEGOBLIN_HEADER_VARIANT)
  const selectedVariant = headerVariants.find((variant) => variant.id === selectedVariantId) ?? headerVariants[0]
  const brandPanelWidth = selectedVariant.brandPanelWidth
  const mascotGrid = selectedVariant.mascotGrid ?? baseMascotGrid
  const mascotColumns = Math.max(...mascotGrid.map((row) => row.length))
  const mascotWidth = mascotColumns * 2
  const interiorWidth = 2 + brandPanelWidth + 4 + mascotWidth + 2

  function fitChunks(chunks: TextChunk[], width: number) {
    const fitted: TextChunk[] = []
    let remaining = width
    for (const chunk of chunks) {
      if (remaining <= 0) break
      const text = chunk.text.slice(0, remaining)
      if (!text) continue
      fitted.push({ ...chunk, text })
      remaining -= text.length
    }
    return fitted
  }

  function renderBrandRow(mascotRowIdx: number) {
    const chunks = fitChunks(selectedVariant.rows[mascotRowIdx] ?? [], brandPanelWidth)

    // Calculate total text length of the chunks
    let totalLen = 0
    for (const chunk of chunks) {
      totalLen += chunk.text.length
    }

    // Calculate remaining padding
    const paddingNeeded = Math.max(0, brandPanelWidth - totalLen)

    return (
      <box flexDirection="row" width={brandPanelWidth}>
        {chunks.map(chunk => (
          <text
            fg={chunk.fg ?? props.theme.textMuted}
            attributes={chunk.attributes}
          >
            {chunk.text}
          </text>
        ))}
        {paddingNeeded > 0 && (
          <text fg={props.theme.textMuted}>
            {" ".repeat(paddingNeeded)}
          </text>
        )}
      </box>
    )
  }

  function renderMascotRow(rowIndex: number) {
    const row = (mascotGrid[rowIndex] ?? "").padEnd(mascotColumns, ".")
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
  
  // Row 0: Top border
  rows.push(
    <box flexDirection="row">
      <text fg={shadowColor}>┌</text>
      <text fg={shadowColor}>{"─".repeat(interiorWidth)}</text>
      <text fg={shadowColor}>┐</text>
    </box>
  )
  
  // Row 1: Empty padding
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
