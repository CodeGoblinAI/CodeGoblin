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

  const buildFontRows = (word: string, font: Record<string, string[]>, gap = 1, shifts: number[] = []) => {
    const letters = [...word].map((char) => font[char] ?? [])
    const height = letters[0]?.length ?? 0
    return Array.from({ length: height }, (_, rowIndex) => {
      const line = letters.map((letter) => letter[rowIndex] ?? "").join(" ".repeat(gap))
      return `${" ".repeat(shifts[rowIndex] ?? 0)}${line}`
    })
  }

  const buildPixelRows = (word: string, glyphs: Record<string, number[][]>, gap = 1, pixel = "█") => {
    const letters = [...word].map((char) => glyphs[char] ?? [])
    const height = letters[0]?.length ?? 0
    return Array.from({ length: height }, (_, rowIndex) =>
      letters
        .map((letter) => (letter[rowIndex] ?? []).map((cell) => (cell ? pixel.repeat(2) : "  ")).join(""))
        .join(" ".repeat(gap)),
    )
  }

  const makeArtRows = (lines: string[], width: number) => {
    const rows = Array.from({ length: 8 }, () => [] as TextChunk[])
    const start = Math.max(0, Math.floor((8 - lines.length) / 2))
    for (let index = 0; index < Math.min(lines.length, 8); index++) {
      rows[start + index] = row(chunk(center(lines[index], width), skinColor, TextAttributes.BOLD))
    }
    return rows
  }

  const makeVariant = (id: string, name: string, lines: string[], mascotGrid = baseMascotGrid, minWidth = 60): HeaderVariant => {
    const brandPanelWidth = Math.max(minWidth, ...lines.map((line) => line.length))
    return {
      id,
      name,
      brandPanelWidth,
      mascotGrid,
      rows: makeArtRows(lines, brandPanelWidth),
    }
  }

  const solidFiveFont = {
    C: ["█████", "█    ", "█    ", "█    ", "█████"],
    O: ["█████", "█   █", "█   █", "█   █", "█████"],
    D: ["████ ", "█   █", "█   █", "█   █", "████ "],
    E: ["█████", "█    ", "████ ", "█    ", "█████"],
    G: ["█████", "█    ", "█  ██", "█   █", "█████"],
    B: ["████ ", "█   █", "████ ", "█   █", "████ "],
    L: ["█    ", "█    ", "█    ", "█    ", "█████"],
    I: ["███", " █ ", " █ ", " █ ", "███"],
    N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  }

  const halfBlockThreeFont = {
    C: ["▄██▄", "█   ", "▀██▀"],
    O: ["▄██▄", "█  █", "▀██▀"],
    D: ["██▄ ", "█  █", "██▀ "],
    E: ["████", "██  ", "████"],
    G: ["▄██▄", "█ ██", "▀██▀"],
    B: ["██▄ ", "██▄ ", "██▀ "],
    L: ["█   ", "█   ", "████"],
    I: ["████", " ██ ", "████"],
    N: ["█▄ █", "█ ██", "█ ▀█"],
  }

  const halfBlockFiveFont = {
    C: ["▄██▄", "█   ", "█   ", "█   ", "▀██▀"],
    O: ["▄██▄", "█  █", "█  █", "█  █", "▀██▀"],
    D: ["██▄ ", "█  █", "█  █", "█  █", "██▀ "],
    E: ["████", "█   ", "███ ", "█   ", "████"],
    G: ["▄██▄", "█   ", "█ ██", "█  █", "▀██▀"],
    B: ["██▄ ", "█  █", "██▄ ", "█  █", "██▀ "],
    L: ["█   ", "█   ", "█   ", "█   ", "████"],
    I: ["████", " █  ", " █  ", " █  ", "████"],
    N: ["█  █", "██ █", "████", "█ ██", "█  █"],
  }

  const compactFourFont = {
    C: ["███", "█  ", "█  ", "███"],
    O: ["███", "█ █", "█ █", "███"],
    D: ["██ ", "█ █", "█ █", "██ "],
    E: ["███", "██ ", "█  ", "███"],
    G: ["███", "█  ", "█ █", "███"],
    B: ["██ ", "███", "█ █", "██ "],
    L: ["█  ", "█  ", "█  ", "███"],
    I: ["███", " █ ", " █ ", "███"],
    N: ["█ █", "███", "█ █", "█ █"],
  }

  const shadedFourFont = {
    C: ["▓███▓", "██   ", "██   ", "▓███▓"],
    O: ["▓███▓", "██ ██", "██ ██", "▓███▓"],
    D: ["███▓ ", "██ ██", "██ ██", "███▓ "],
    E: ["█████", "███  ", "██   ", "█████"],
    G: ["▓███▓", "██   ", "██ ██", "▓███▓"],
    B: ["███▓ ", "████▓", "██ ██", "███▓ "],
    L: ["██   ", "██   ", "██   ", "█████"],
    I: ["█████", " ██  ", " ██  ", "█████"],
    N: ["██ ██", "█████", "█████", "██ ██"],
  }

  const dotMatrixFont = {
    C: [" ●●●", "●   ", "●   ", "●   ", " ●●●"],
    O: [" ●● ", "●  ●", "●  ●", "●  ●", " ●● "],
    D: ["●●  ", "● ● ", "●  ●", "● ● ", "●●  "],
    E: ["●●●●", "●   ", "●●● ", "●   ", "●●●●"],
    G: [" ●●●", "●   ", "● ● ", "●  ●", " ●●●"],
    B: ["●●  ", "● ● ", "●●  ", "● ● ", "●●  "],
    L: ["●   ", "●   ", "●   ", "●   ", "●●●●"],
    I: ["●●●", " ● ", " ● ", " ● ", "●●●"],
    N: ["●  ●", "●● ●", "● ●●", "●  ●", "●  ●"],
  }

  const outlineFiveFont = {
    C: ["┌───┐", "│    ", "│    ", "│    ", "└───┘"],
    O: ["┌───┐", "│   │", "│   │", "│   │", "└───┘"],
    D: ["┌──┐ ", "│  │ ", "│  │ ", "│  │ ", "└──┘ "],
    E: ["┌────", "│    ", "├──  ", "│    ", "└────"],
    G: ["┌───┐", "│    ", "│ ─┐ ", "│  │ ", "└──┘ "],
    B: ["┌──┐ ", "│  │ ", "├──┘ ", "│  │ ", "└──┘ "],
    L: ["│    ", "│    ", "│    ", "│    ", "└────"],
    I: ["─┬── ", " │   ", " │   ", " │   ", "─┴── "],
    N: ["│  │ ", "│╲ │ ", "│ ╲│ ", "│  │ ", "│  │ "],
  }

  const pixelFourGlyphs = {
    C: [[0, 1, 1, 1], [1, 0, 0, 0], [1, 0, 0, 0], [0, 1, 1, 1]],
    O: [[0, 1, 1, 0], [1, 0, 0, 1], [1, 0, 0, 1], [0, 1, 1, 0]],
    D: [[1, 1, 1, 0], [1, 0, 0, 1], [1, 0, 0, 1], [1, 1, 1, 0]],
    E: [[1, 1, 1, 1], [1, 0, 0, 0], [1, 1, 0, 0], [1, 1, 1, 1]],
    G: [[0, 1, 1, 0], [1, 0, 0, 0], [1, 0, 1, 1], [0, 1, 1, 0]],
    B: [[1, 1, 0, 0], [1, 0, 1, 0], [1, 1, 0, 0], [1, 1, 0, 0]],
    L: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [1, 1, 1, 1]],
    I: [[1, 1, 1], [0, 1, 0], [0, 1, 0], [1, 1, 1]],
    N: [[1, 0, 0, 1], [1, 1, 0, 1], [1, 0, 1, 1], [1, 0, 0, 1]],
  }

  const splitPixelRows = [
    ...buildPixelRows("CODE", pixelFourGlyphs, 2),
    ...buildPixelRows("GOBLIN", pixelFourGlyphs, 2),
  ]

  const headerVariants: HeaderVariant[] = [
    makeVariant("01", "5-row solid block, 1-space gaps", buildFontRows("CODEGOBLIN", solidFiveFont, 1), baseMascotGrid),
    makeVariant("02", "5-row solid block, 2-space gaps", buildFontRows("CODEGOBLIN", solidFiveFont, 2), baseMascotGrid),
    makeVariant("03", "3-row half-block arcade", buildFontRows("CODEGOBLIN", halfBlockThreeFont, 2), baseMascotGrid),
    makeVariant("04", "5-row half-block arcade", buildFontRows("CODEGOBLIN", halfBlockFiveFont, 2), cheekMascotGrid),
    makeVariant("05", "4-row compact block, wide gaps", buildFontRows("CODEGOBLIN", compactFourFont, 3), narrowMascotGrid),
    makeVariant("06", "4-row shaded block", buildFontRows("CODEGOBLIN", shadedFourFont, 1), cheekMascotGrid),
    makeVariant("07", "5-row dot-matrix glyphs", buildFontRows("CODEGOBLIN", dotMatrixFont, 2), baseMascotGrid),
    makeVariant("08", "5-row slant-cancel solid", buildFontRows("CODEGOBLIN", solidFiveFont, 1, [3, 2, 1, 0, 0]), baseMascotGrid),
    makeVariant("09", "split CODE/GOBLIN pixel blocks", splitPixelRows, narrowMascotGrid),
    makeVariant("10", "5-row outline box glyphs", buildFontRows("CODEGOBLIN", outlineFiveFont, 1), cheekMascotGrid),
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
