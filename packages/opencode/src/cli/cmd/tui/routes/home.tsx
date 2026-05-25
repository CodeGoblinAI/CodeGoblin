import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
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
    gap?: number
    mascotSide?: "left" | "right"
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

  const miniMascotGrid = [
    "....GGGG....",
    "..GGGGGGGG..",
    "G.GGGGGGGG.G",
    ".GGGGGGGGGG.",
    "..GGBBGGBG..",
    "..GGBBGGBG..",
    "...GGGGGG...",
    "....GGGG....",
  ]

  const microMascotGrid = [
    "...GG...",
    "..GGGG..",
    ".GGGGGG.",
    "GGGBBGGG",
    "GGGBBGGG",
    ".GGGGGG.",
    "..GGGG..",
    "...GG...",
  ]

  const tinyMascotGrid = [
    "..GG..",
    ".GGGG.",
    "GGGGGG",
    "GGBBGG",
    "GGBBGG",
    "GGGGGG",
    ".GGGG.",
    "..GG..",
  ]

  const blankMascotGrid = Array.from({ length: 8 }, () => "")

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

  const splitFontRows = (topWord: string, bottomWord: string, font: Record<string, string[]>, gap = 1, spacer = 0) => [
    ...buildFontRows(topWord, font, gap),
    ...Array.from({ length: spacer }, () => ""),
    ...buildFontRows(bottomWord, font, gap),
  ]

  const splitPixelRowsFor = (topWord: string, bottomWord: string, glyphs: Record<string, number[][]>, gap = 1, pixel = "█", spacer = 0) => [
    ...buildPixelRows(topWord, glyphs, gap, pixel),
    ...Array.from({ length: spacer }, () => ""),
    ...buildPixelRows(bottomWord, glyphs, gap, pixel),
  ]

  const offsetRows = (lines: string[], offsets: number[]) =>
    lines.map((line, index) => `${" ".repeat(offsets[index] ?? 0)}${line}`)

  const makeArtRows = (lines: string[], width: number) => {
    const rows = Array.from({ length: 8 }, () => [] as TextChunk[])
    const start = Math.max(0, Math.floor((8 - lines.length) / 2))
    for (let index = 0; index < Math.min(lines.length, 8); index++) {
      rows[start + index] = row(chunk(center(lines[index], width), skinColor, TextAttributes.BOLD))
    }
    return rows
  }

  const makeVariant = (
    id: string,
    name: string,
    lines: string[],
    mascotGrid = baseMascotGrid,
    minWidth = 60,
    gap = 4,
    mascotSide: "left" | "right" = "right",
  ): HeaderVariant => {
    const brandPanelWidth = Math.max(minWidth, ...lines.map((line) => line.length))
    return {
      id,
      name,
      brandPanelWidth,
      gap,
      mascotSide,
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

  const pixelThreeGlyphs = {
    C: [[0, 1, 1, 1], [1, 0, 0, 0], [0, 1, 1, 1]],
    O: [[0, 1, 1, 0], [1, 0, 0, 1], [0, 1, 1, 0]],
    D: [[1, 1, 1, 0], [1, 0, 0, 1], [1, 1, 1, 0]],
    E: [[1, 1, 1, 1], [1, 1, 0, 0], [1, 1, 1, 1]],
    G: [[0, 1, 1, 1], [1, 0, 1, 1], [0, 1, 1, 0]],
    B: [[1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0]],
    L: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 1, 1, 1]],
    I: [[1, 1, 1], [0, 1, 0], [1, 1, 1]],
    N: [[1, 0, 1], [1, 1, 1], [1, 0, 1]],
  }

  const headerVariants: HeaderVariant[] = [
    makeVariant("01", "compact 4-row full word, right narrow goblin", buildFontRows("CODEGOBLIN", compactFourFont, 3), narrowMascotGrid, 60, 8),
    makeVariant("02", "compact 4-row full word, left narrow goblin", buildFontRows("CODEGOBLIN", compactFourFont, 4), narrowMascotGrid, 60, 8, "left"),
    makeVariant("03", "compact 4-row full word, mini goblin", buildFontRows("CODEGOBLIN", compactFourFont, 5), miniMascotGrid, 60, 10),
    makeVariant("04", "compact 4-row slant-cancel, right goblin", buildFontRows("CODEGOBLIN", compactFourFont, 3, [2, 1, 0, 0]), narrowMascotGrid, 60, 8),
    makeVariant("05", "compact 4-row slant-cancel, left goblin", buildFontRows("CODEGOBLIN", compactFourFont, 3, [3, 2, 1, 0]), narrowMascotGrid, 60, 8, "left"),
    makeVariant("06", "3-row half-block full word, right goblin", buildFontRows("CODEGOBLIN", halfBlockThreeFont, 3), baseMascotGrid, 60, 8),
    makeVariant("07", "3-row half-block full word, left goblin", buildFontRows("CODEGOBLIN", halfBlockThreeFont, 3), baseMascotGrid, 60, 8, "left"),
    makeVariant("08", "5-row solid slant-cancel, mini goblin", buildFontRows("CODEGOBLIN", solidFiveFont, 1, [4, 3, 2, 1, 0]), miniMascotGrid, 60, 8),
    makeVariant("09", "5-row solid slant-cancel, left mini goblin", buildFontRows("CODEGOBLIN", solidFiveFont, 1, [5, 4, 2, 1, 0]), miniMascotGrid, 60, 8, "left"),
    makeVariant("10", "4-row shaded full word, cheek goblin", buildFontRows("CODEGOBLIN", shadedFourFont, 2), cheekMascotGrid, 60, 8),
    makeVariant("11", "split compact CODE/GOBLIN, right narrow goblin", splitFontRows("CODE", "GOBLIN", compactFourFont, 3), narrowMascotGrid, 60, 10),
    makeVariant("12", "split compact CODE/GOBLIN, left narrow goblin", splitFontRows("CODE", "GOBLIN", compactFourFont, 4), narrowMascotGrid, 60, 10, "left"),
    makeVariant("13", "split half-block CODE/GOBLIN, right goblin", splitFontRows("CODE", "GOBLIN", halfBlockThreeFont, 3, 1), baseMascotGrid, 60, 8),
    makeVariant("14", "split half-block CODE/GOBLIN, left cheek goblin", splitFontRows("CODE", "GOBLIN", halfBlockThreeFont, 3, 1), cheekMascotGrid, 60, 8, "left"),
    makeVariant("15", "split 4-row pixel CODE/GOBLIN, right mini goblin", splitPixelRowsFor("CODE", "GOBLIN", pixelFourGlyphs, 2), miniMascotGrid, 60, 10),
    makeVariant("16", "split 4-row pixel CODE/GOBLIN, left mini goblin", splitPixelRowsFor("CODE", "GOBLIN", pixelFourGlyphs, 3), miniMascotGrid, 60, 10, "left"),
    makeVariant("17", "split 3-row pixel CODE/GOBLIN, right narrow goblin", splitPixelRowsFor("CODE", "GOBLIN", pixelThreeGlyphs, 4, "█", 1), narrowMascotGrid, 60, 10),
    makeVariant("18", "split 3-row pixel CODE/GOBLIN, left narrow goblin", splitPixelRowsFor("CODE", "GOBLIN", pixelThreeGlyphs, 5, "█", 1), narrowMascotGrid, 60, 10, "left"),
    makeVariant("19", "split dot-matrix CODE/GOBLIN, cheek goblin", splitFontRows("CODE", "GOBLIN", dotMatrixFont, 4), cheekMascotGrid, 60, 8),
    makeVariant("20", "split outline CODE/GOBLIN, mini goblin left", splitFontRows("CODE", "GOBLIN", outlineFiveFont, 1).slice(1, 9), miniMascotGrid, 60, 10, "left"),
    makeVariant("21", "5-row solid slant-cancel, micro goblin", buildFontRows("CODEGOBLIN", solidFiveFont, 1, [4, 3, 2, 1, 0]), microMascotGrid, 60, 12),
    makeVariant("22", "5-row solid slant-cancel, text only", buildFontRows("CODEGOBLIN", solidFiveFont, 1, [4, 3, 2, 1, 0]), blankMascotGrid, 60, 0),
    makeVariant("23", "5-row solid slant-cancel, left tiny goblin", buildFontRows("CODEGOBLIN", solidFiveFont, 1, [5, 4, 2, 1, 0]), tinyMascotGrid, 60, 12, "left"),
    makeVariant("24", "5-row solid slant-cancel left-bias, text only", buildFontRows("CODEGOBLIN", solidFiveFont, 1, [5, 4, 2, 1, 0]), blankMascotGrid, 60, 0),
    makeVariant("25", "4-row shaded full word, tiny goblin", buildFontRows("CODEGOBLIN", shadedFourFont, 2), tinyMascotGrid, 60, 12),
    makeVariant("26", "4-row shaded full word, text only", buildFontRows("CODEGOBLIN", shadedFourFont, 2), blankMascotGrid, 60, 0),
    makeVariant("27", "split compact CODE/GOBLIN, text only", splitFontRows("CODE", "GOBLIN", compactFourFont, 3), blankMascotGrid, 60, 0),
    makeVariant("28", "split half-block CODE/GOBLIN, text only", splitFontRows("CODE", "GOBLIN", halfBlockThreeFont, 3, 1), blankMascotGrid, 60, 0),
    makeVariant("29", "split 4-row pixel CODE/GOBLIN, text only", splitPixelRowsFor("CODE", "GOBLIN", pixelFourGlyphs, 2), blankMascotGrid, 60, 0),
    makeVariant("30", "split dot-matrix CODE/GOBLIN, text only", splitFontRows("CODE", "GOBLIN", dotMatrixFont, 4), blankMascotGrid, 60, 0),
    makeVariant("31", "wide solid full word, text only", buildFontRows("CODEGOBLIN", solidFiveFont, 3), blankMascotGrid, 72, 0),
    makeVariant("32", "wide solid slant-cancel, text only", buildFontRows("CODEGOBLIN", solidFiveFont, 2, [6, 4, 3, 1, 0]), blankMascotGrid, 72, 0),
    makeVariant("33", "wide shaded full word, text only", buildFontRows("CODEGOBLIN", shadedFourFont, 4), blankMascotGrid, 72, 0),
    makeVariant("34", "wide outline full word, text only", buildFontRows("CODEGOBLIN", outlineFiveFont, 2), blankMascotGrid, 72, 0),
    makeVariant("35", "split compact wide-gap, text only", splitFontRows("CODE", "GOBLIN", compactFourFont, 6), blankMascotGrid, 72, 0),
    makeVariant("36", "split compact stagger-right, text only", offsetRows(splitFontRows("CODE", "GOBLIN", compactFourFont, 5), [0, 0, 0, 0, 14, 14, 14, 14]), blankMascotGrid, 72, 0),
    makeVariant("37", "split compact stagger-left, text only", offsetRows(splitFontRows("CODE", "GOBLIN", compactFourFont, 5), [12, 12, 12, 12, 0, 0, 0, 0]), blankMascotGrid, 72, 0),
    makeVariant("38", "split half-block wide, text only", splitFontRows("CODE", "GOBLIN", halfBlockThreeFont, 6, 2), blankMascotGrid, 72, 0),
    makeVariant("39", "split 4-row pixel wide, text only", splitPixelRowsFor("CODE", "GOBLIN", pixelFourGlyphs, 4), blankMascotGrid, 72, 0),
    makeVariant("40", "split 3-row pixel staggered, text only", offsetRows(splitPixelRowsFor("CODE", "GOBLIN", pixelThreeGlyphs, 8, "█", 2), [0, 0, 0, 0, 10, 10, 10, 10]), blankMascotGrid, 72, 0),
  ]

  function normalizeVariantId(value: string | undefined) {
    const cleaned = value?.trim().replace(/^v/i, "")
    const numeric = Number(cleaned)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 40) return String(numeric).padStart(2, "0")
    return "09"
  }

  const selectedVariantId = normalizeVariantId(process.env.CODEGOBLIN_HEADER_VARIANT)
  const selectedVariant = headerVariants.find((variant) => variant.id === selectedVariantId) ?? headerVariants[0]
  const brandPanelWidth = selectedVariant.brandPanelWidth
  const mascotGrid = selectedVariant.mascotGrid ?? baseMascotGrid
  const mascotSide = selectedVariant.mascotSide ?? "right"
  const gap = selectedVariant.gap ?? 4
  const mascotColumns = Math.max(...mascotGrid.map((row) => row.length))
  const mascotWidth = mascotColumns * 2
  const interiorWidth = 2 + brandPanelWidth + gap + mascotWidth + 2

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
    if (mascotSide === "left") {
      rows.push(
        <box flexDirection="row">
          {borderLeft}
          <text>  </text>
          {renderMascotRow(i)}
          <text>{" ".repeat(gap)}</text>
          {renderBrandRow(i)}
          <text>  </text>
          {borderRight}
        </box>,
      )
    } else {
      rows.push(
        <box flexDirection="row">
          {borderLeft}
          <text>  </text>
          {renderBrandRow(i)}
          <text>{" ".repeat(gap)}</text>
          {renderMascotRow(i)}
          <text>  </text>
          {borderRight}
        </box>,
      )
    }
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

function TuiGoblinRunner(props: { theme: any }) {
  const dimensions = useTerminalDimensions()
  const skinColor = RGBA.fromInts(154, 219, 53)
  const shadowColor = RGBA.fromInts(120, 125, 135)
  const vestColor = RGBA.fromInts(130, 80, 223)
  const eyeColor = props.theme.backgroundElement
  const [tick, setTick] = createSignal(0)

  const runnerFrames = [
    [
      ".G..G.",
      "GGGGGG",
      "GGBBGG",
      ".GPPG.",
      "G....G",
    ],
    [
      ".G..G.",
      "GGGGGG",
      "GGBBGG",
      ".GPPG.",
      ".GGGG.",
    ],
    [
      ".G..G.",
      "GGGGGG",
      "GGBBGG",
      ".GPPG.",
      ".G..G.",
    ],
    [
      ".G..G.",
      "GGGGGG",
      "GGBBGG",
      ".GPPG.",
      "G.G..G",
    ],
  ]

  const spriteHeight = runnerFrames[0]?.length ?? 0
  const spriteWidth = Math.max(...runnerFrames.flatMap((frame) => frame.map((row) => row.length)))
  const laneCells = () => {
    const availableChars = Math.max(12, dimensions().width - 8)
    return Math.max(spriteWidth + 4, Math.min(28, Math.floor(availableChars / 2)))
  }
  const laneWidth = () => laneCells() * 2
  const spriteOffset = () => {
    const travel = laneCells() + spriteWidth + 2
    return (tick() % travel) - spriteWidth
  }

  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    timer = setInterval(() => setTick((value) => value + 1), 120)
    timer?.unref?.()
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  function renderRunnerRow(rowIndex: number) {
    const frame = runnerFrames[tick() % runnerFrames.length] ?? runnerFrames[0] ?? []
    const spriteRow = frame[rowIndex] ?? "".padEnd(spriteWidth, ".")
    const offset = spriteOffset()
    const cells: JSX.Element[] = []

    for (let cell = 0; cell < laneCells(); cell++) {
      const spriteColumn = cell - offset
      const char = spriteColumn >= 0 && spriteColumn < spriteRow.length ? spriteRow[spriteColumn] : "."

      if (char === "G") {
        cells.push(<text fg={skinColor}>██</text>)
      } else if (char === "P") {
        cells.push(<text fg={vestColor}>██</text>)
      } else if (char === "B") {
        cells.push(<text fg={eyeColor}>██</text>)
      } else if (rowIndex === spriteHeight - 1 && cell >= Math.max(0, offset - 2) && cell < Math.max(0, offset)) {
        cells.push(<text fg={shadowColor}>░░</text>)
      } else {
        cells.push(<text>  </text>)
      }
    }

    return cells
  }

  return (
    <box flexDirection="column" alignItems="center" width="100%" paddingTop={1} paddingBottom={1}>
      {Array.from({ length: spriteHeight }, (_, rowIndex) => (
        <box flexDirection="row" width={laneWidth()}>
          {renderRunnerRow(rowIndex)}
        </box>
      ))}
      <box flexDirection="row" width={laneWidth()}>
        <text fg={shadowColor}>{"▁".repeat(laneWidth())}</text>
      </box>
      <text fg={props.theme.textMuted}>token goblin jogging receipts</text>
    </box>
  )
}

function isFooterAnimationEnabled(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
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
  const showFooterAnimation = isFooterAnimationEnabled(process.env.CODEGOBLIN_FOOTER_ANIMATION)
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
        {showFooterAnimation ? <TuiGoblinRunner theme={theme} /> : null}
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
