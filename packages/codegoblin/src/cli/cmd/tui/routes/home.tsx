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
  const goldColor = RGBA.fromInts(245, 200, 75)
  const borderColor = RGBA.fromInts(43, 109, 49)

  interface TextChunk {
    text: string
    fg?: any
    attributes?: number
  }

  interface HeaderHelperNote {
    label: string
    text: string
  }

  interface HeaderVariant {
    id: string
    name: string
    brandPanelWidth: number
    rows: TextChunk[][]
    gap?: number
    mascotSide?: "left" | "right"
    mascotGrid?: string[]
    helperTitle?: string
    helperNotes?: HeaderHelperNote[]
  }

  const chunk = (text: string, fg?: any, attributes?: number): TextChunk => ({ text, fg, attributes })
  const row = (...chunks: TextChunk[]) => chunks
  const center = (text: string, width: number) => {
    const clipped = text.slice(0, width)
    const left = Math.floor((width - clipped.length) / 2)
    return `${" ".repeat(left)}${clipped}`
  }

  // Goblin mascot variants stay 8 rows high so the bordered header box remains compact.
  // Matches the web favicon, taller for near-square proportions: pointed ears, a clean eye band with a
  // big square left eye + thin slit right eye, and a jaw tapering to a chin point.
  const baseMascotGrid = [
    "...GGGGGGGG...",
    "G.GGGGGGGGGG.G",
    "GG.GGGGGGGG.GG",
    "GGGGGGGGGGGGGG",
    ".GGGBBGGGGBGG.",
    ".GGGBBGGGGBGG.",
    ".GGGGGGGGGGGG.",
    "..GGGGGGGGGG..",
    "...GGGGGGGG...",
    ".....GGGG.....",
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
    "GG.GGGGGG.GG",
    ".GGGGGGGGGG.",
    ".GGBBGGBBGG.",
    ".GGBBGGBBGG.",
    "..GGGGGGGG..",
    "...GGGGGG...",
  ]

  const detailedMiniMascotGrid = [
    "....SGGS....",
    "..SGGGGGGS..",
    ".GSGGGGGGGSG",
    "SGGGGGGGGGGS",
    ".GGGBMMBGGG.",
    ".GGGPMMPGGG.",
    "..SGGGGGGS..",
    "...SPPPPS...",
  ]

  const scoutMiniMascotGrid = [
    "S...GGGG...S",
    ".SGGGGGGGGS.",
    "SGGGGGGGGGGS",
    ".GGGGGGGGGG.",
    ".GGGBSSBGGG.",
    ".GGGSMMSGGG.",
    "..SGGPPGGS..",
    "...SPPPPS...",
  ]

  const cheekMiniMascotGrid = [
    "....SGGS....",
    "..SGGGGGGS..",
    ".GSGGGGGGGSG",
    "SGGGGGGGGGGS",
    ".GGGBSSBGGG.",
    ".GGGPMMPGGG.",
    "..SGGGPGGS..",
    "...SPPPPS...",
  ]

  const scarMiniMascotGrid = [
    "....SGGS....",
    "..SGGGGGGS..",
    ".GSGGGGGGGSG",
    "SGGGSGGGGGGS",
    ".GGGBSMBGGG.",
    ".GGGPPPPGGG.",
    "..SGGGGGGS..",
    "...SPPPPS...",
  ]

  const earShadowMiniMascotGrid = [
    "....GGGG....",
    "..SGGGGGGS..",
    "G.GGGGGGGG.G",
    ".GGGGGGGGGG.",
    "..GSBBGGBS..",
    "..GGSMMSGG..",
    "...GGGGGG...",
    "....GGGG....",
  ]

  const hoodShadowMiniMascotGrid = [
    "....SGGS....",
    "..GGGGGGGG..",
    "S.GGGGGGGG.S",
    ".SGGGGGGGGS.",
    "..GGBBGGBG..",
    "..GGSMMSGG..",
    "...GGGGGG...",
    "....SGGS....",
  ]

  const browMiniMascotGrid = [
    "....GGGG....",
    "..GGGGGGGG..",
    "G.GGGGGGGG.G",
    ".SGGGGGGGGS.",
    "..GSBBMBSG..",
    "..GGGMMGGG..",
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

  const commandHelperNotes: HeaderHelperNote[] = [
    { label: "slash", text: "/init setup · /review changes · /goblin help" },
    { label: "more", text: "/editor long prompt · /skills browse · /codegoblin alias" },
    { label: "mention", text: "@agent delegate · @file#12-20 attach context" },
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

  const splitFontRows = (topWord: string, bottomWord: string, font: Record<string, string[]>, gap = 1, spacer = 0) => [
    ...buildFontRows(topWord, font, gap),
    ...Array.from({ length: spacer }, () => ""),
    ...buildFontRows(bottomWord, font, gap),
  ]

  const splitPixelRowsFor = (
    topWord: string,
    bottomWord: string,
    glyphs: Record<string, number[][]>,
    gap = 1,
    pixel = "█",
    spacer = 0,
  ) => [
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
    I: ["█████", "  █  ", "  █  ", "  █  ", "█████"],
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

  const solidSlantRows = buildFontRows("CODEGOBLIN", solidFiveFont, 1, [4, 3, 2, 1, 0])
  const solidLeftBiasRows = buildFontRows("CODEGOBLIN", solidFiveFont, 1, [5, 4, 2, 1, 0])
  // Widen each glyph pixel to 2 chars so the wordmark renders square (like the mascot) instead of tall + stretched.
  const widenPixels = (lines: string[]) =>
    lines.map((line) => [...line].map((ch) => (ch === " " ? "  " : ch.repeat(2))).join(""))
  const codeGoblinWordmark = widenPixels(buildFontRows("CODEGOBLIN", solidFiveFont, 1))

  const headerVariants: HeaderVariant[] = [
    makeVariant("01", "compact 4-row full word, right narrow goblin", buildFontRows("CODEGOBLIN", compactFourFont, 3), narrowMascotGrid, 60, 8),
    makeVariant("02", "compact 4-row full word, left narrow goblin", buildFontRows("CODEGOBLIN", compactFourFont, 4), narrowMascotGrid, 60, 8, "left"),
    makeVariant("03", "compact 4-row full word, mini goblin", buildFontRows("CODEGOBLIN", compactFourFont, 5), miniMascotGrid, 60, 10),
    makeVariant("04", "compact 4-row slant-cancel, right goblin", buildFontRows("CODEGOBLIN", compactFourFont, 3, [2, 1, 0, 0]), narrowMascotGrid, 60, 8),
    makeVariant("05", "compact 4-row slant-cancel, left goblin", buildFontRows("CODEGOBLIN", compactFourFont, 3, [3, 2, 1, 0]), narrowMascotGrid, 60, 8, "left"),
    makeVariant("06", "3-row half-block full word, right goblin", buildFontRows("CODEGOBLIN", halfBlockThreeFont, 3), baseMascotGrid, 60, 8),
    makeVariant("07", "3-row half-block full word, left goblin", buildFontRows("CODEGOBLIN", halfBlockThreeFont, 3), baseMascotGrid, 60, 8, "left"),
    makeVariant("08", "5-row solid slant-cancel, mini goblin", solidSlantRows, miniMascotGrid, 60, 8),
    {
      // Square (2-wide) single-line wordmark so CODEGOBLIN reads crisply at the mascot's scale instead of stretching tall.
      ...makeVariant("09", "square pixel CODEGOBLIN, left base goblin", codeGoblinWordmark, baseMascotGrid, 60, 6, "left"),
      helperNotes: commandHelperNotes,
    },
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
    makeVariant("21", "5-row solid slant-cancel, micro goblin", solidSlantRows, microMascotGrid, 60, 12),
    makeVariant("22", "5-row solid slant-cancel, text only", solidSlantRows, blankMascotGrid, 60, 0),
    makeVariant("23", "5-row solid slant-cancel, left tiny goblin", solidLeftBiasRows, tinyMascotGrid, 60, 12, "left"),
    makeVariant("24", "5-row solid slant-cancel left-bias, text only", solidLeftBiasRows, blankMascotGrid, 60, 0),
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
    {
      ...makeVariant("41", "design 9 with hooded detail goblin", solidLeftBiasRows, detailedMiniMascotGrid, 60, 8, "left"),
      helperNotes: commandHelperNotes,
    },
    {
      ...makeVariant("42", "design 9 with scout goblin ears", solidLeftBiasRows, scoutMiniMascotGrid, 60, 8, "left"),
      helperNotes: commandHelperNotes,
    },
    {
      ...makeVariant("43", "design 9 with cheek detail goblin", solidLeftBiasRows, cheekMiniMascotGrid, 60, 8, "left"),
      helperNotes: commandHelperNotes,
    },
    {
      ...makeVariant("44", "design 9 with scarred hood goblin", solidLeftBiasRows, scarMiniMascotGrid, 60, 8, "left"),
      helperNotes: commandHelperNotes,
    },
    {
      ...makeVariant("45", "design 9 subtle ear-shadow goblin", solidLeftBiasRows, earShadowMiniMascotGrid, 60, 8, "left"),
      helperNotes: commandHelperNotes,
    },
    {
      ...makeVariant("46", "design 9 subtle hood-shadow goblin", solidLeftBiasRows, hoodShadowMiniMascotGrid, 60, 8, "left"),
      helperNotes: commandHelperNotes,
    },
    {
      ...makeVariant("47", "design 9 subtle brow goblin", solidLeftBiasRows, browMiniMascotGrid, 60, 8, "left"),
      helperNotes: commandHelperNotes,
    },
  ]

  function normalizeVariantId(value: string | undefined) {
    const cleaned = value?.trim().replace(/^v/i, "")
    const numeric = Number(cleaned)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 47) return String(numeric).padStart(2, "0")
    return "09"
  }

  const selectedVariantId = normalizeVariantId(process.env.CODEGOBLIN_HEADER_VARIANT)
  const selectedVariant =
    headerVariants.find((variant) => variant.id === selectedVariantId) ??
    headerVariants.find((variant) => variant.id === "09") ??
    headerVariants[0]
  const brandPanelWidth = selectedVariant.brandPanelWidth
  const mascotGrid = selectedVariant.mascotGrid ?? baseMascotGrid
  const mascotSide = selectedVariant.mascotSide ?? "right"
  const gap = selectedVariant.gap ?? 4
  const mascotColumns = Math.max(...mascotGrid.map((row) => row.length))
  const mascotWidth = mascotColumns * 2
  const interiorWidth = 2 + brandPanelWidth + gap + mascotWidth + 2
  // Let the mascot drive the header height so a taller (more square) goblin can match the favicon.
  // The 8-row wordmark is vertically centred against it.
  const artHeight = Math.max(8, mascotGrid.length)
  const brandPad = Math.floor((artHeight - 8) / 2)

  function fitChunks(chunks: TextChunk[], width: number) {
    const fitted: TextChunk[] = []
    let remaining = width
    for (const part of chunks) {
      if (remaining <= 0) break
      const text = part.text.slice(0, remaining)
      if (!text) continue
      fitted.push({ ...part, text })
      remaining -= text.length
    }
    return fitted
  }

  function renderBrandRow(mascotRowIdx: number) {
    const chunks = fitChunks(selectedVariant.rows[mascotRowIdx] ?? [], brandPanelWidth)
    let totalLen = 0
    for (const part of chunks) {
      totalLen += part.text.length
    }
    const paddingNeeded = Math.max(0, brandPanelWidth - totalLen)

    return (
      <box flexDirection="row" width={brandPanelWidth}>
        {chunks.map((part) => (
          <text fg={part.fg ?? props.theme.textMuted} attributes={part.attributes}>
            {part.text}
          </text>
        ))}
        {paddingNeeded > 0 ? <text fg={props.theme.textMuted}>{" ".repeat(paddingNeeded)}</text> : null}
      </box>
    )
  }

  function renderMascotRow(rowIndex: number) {
    const mascotRow = (mascotGrid[rowIndex] ?? "").padEnd(mascotColumns, ".")
    const elements: JSX.Element[] = []
    for (const char of mascotRow) {
      if (char === "G") {
        elements.push(<text fg={skinColor}>██</text>)
      } else if (char === "S") {
        elements.push(<text fg={shadowColor}>██</text>)
      } else if (char === "P") {
        elements.push(<text fg={vestColor}>██</text>)
      } else if (char === "B") {
        elements.push(<text fg={eyeColor}>██</text>)
      } else if (char === "M") {
        elements.push(<text fg={props.theme.textMuted}>██</text>)
      } else {
        elements.push(<text>  </text>)
      }
    }
    return elements
  }

  const rows: JSX.Element[] = []
  const borderLeft = <text fg={borderColor}>│</text>
  const borderRight = <text fg={borderColor}>│</text>
  const hasHelperText = Boolean(selectedVariant.helperTitle || selectedVariant.helperNotes?.length)

  rows.push(
    <box flexDirection="row">
      <text fg={goldColor}>┌</text>
      <text fg={borderColor}>{"─".repeat(interiorWidth)}</text>
      <text fg={goldColor}>┐</text>
    </box>,
  )

  rows.push(
    <box flexDirection="row">
      {borderLeft}
      <text>{" ".repeat(interiorWidth)}</text>
      {borderRight}
    </box>,
  )

  for (let i = 0; i < artHeight; i++) {
    if (mascotSide === "left") {
      rows.push(
        <box flexDirection="row">
          {borderLeft}
          <text>  </text>
          {renderMascotRow(i)}
          <text>{" ".repeat(gap)}</text>
          {renderBrandRow(i - brandPad)}
          <text>  </text>
          {borderRight}
        </box>,
      )
    } else {
      rows.push(
        <box flexDirection="row">
          {borderLeft}
          <text>  </text>
          {renderBrandRow(i - brandPad)}
          <text>{" ".repeat(gap)}</text>
          {renderMascotRow(i)}
          <text>  </text>
          {borderRight}
        </box>,
      )
    }
  }

  rows.push(
    <box flexDirection="row">
      <text fg={goldColor}>└</text>
      <text fg={borderColor}>{"─".repeat(interiorWidth)}</text>
      <text fg={goldColor}>┘</text>
    </box>,
  )

  return <box flexDirection="column" alignItems="center">{rows}</box>
}

function TuiGoblinRunner(props: { theme: any }) {
  const dimensions = useTerminalDimensions()
  const skinColor = RGBA.fromInts(154, 219, 53)
  const shadowColor = RGBA.fromInts(120, 125, 135)
  const vestColor = RGBA.fromInts(130, 80, 223)
  const eyeColor = props.theme.backgroundElement
  const [tick, setTick] = createSignal(0)

  interface RunnerVariant {
    id: string
    name: string
    frames: string[][]
  }

  const runnerVariants: RunnerVariant[] = [
    {
      id: "01",
      name: "tiny classic",
      frames: [
        [".G..G.", "GGGGGG", "GGBBGG", ".GGGG.", ".GPPG.", "G...G."],
        [".G..G.", "GGGGGG", "GGBBGG", ".GGGG.", ".GPPG.", ".GGGG."],
        [".G..G.", "GGGGGG", "GGBBGG", ".GGGG.", ".GGPG.", ".G..G."],
        [".G..G.", "GGGGGG", "GGBBGG", ".GGGG.", ".GPPG.", "G.G.G."],
      ],
    },
    {
      id: "02",
      name: "micro scout",
      frames: [
        ["..S..S..", ".GGGGGG.", "SGGBBGGS", ".GGGGGG.", "..GPPG..", ".G..G.G."],
        ["..S..S..", ".GGGGGG.", "SGGBBGGS", ".GGGGGG.", "..GGPG..", "..GGGG.."],
        ["..S..S..", ".GGGGGG.", "SGGBBGGS", ".GGGGGG.", ".GPPGG..", ".G.G..G."],
        ["..S..S..", ".GGGGGG.", "SGGBBGGS", ".GGGGGG.", "..GPPGG.", "..G..G.."],
      ],
    },
    {
      id: "03",
      name: "round bobber",
      frames: [
        ["..S....S..", ".SGGGGGGS.", "SGGGBBGGGS", ".GGGGGGGG.", "..GPPPGG..", ".G..G.G..."],
        ["..S....S..", ".SGGGGGGS.", "SGGGBBGGGS", ".GGGGGGGG.", "..GGPPGG..", "...GGG...."],
        ["..S....S..", ".SGGGGGGS.", "SGGGBBGGGS", ".GGGGGGGG.", ".GGPPPG...", "..G.G..G.."],
        ["..S....S..", ".SGGGGGGS.", "SGGGBBGGGS", ".GGGGGGGG.", "..GPPPGG..", ".G.G...G.."],
      ],
    },
    {
      id: "04",
      name: "hooded runner",
      frames: [
        ["..P....P..", ".PGGGGGGP.", "PGGGBBGGGP", ".GGGGGGGG.", "..GPPPGG..", ".G..G.G..."],
        ["..P....P..", ".PGGGGGGP.", "PGGGBBGGGP", ".GGGGGGGG.", "..GGPPGG..", "...GGG...."],
        ["..P....P..", ".PGGGGGGP.", "PGGGBBGGGP", "..GGGGGG..", ".GGPPPG...", "..G.G..G.."],
        ["..P....P..", ".PGGGGGGP.", "PGGGBBGGGP", ".GGGGGGGG.", "..GPPPGG..", ".G.G...G.."],
      ],
    },
    {
      id: "05",
      name: "big ear scout",
      frames: [
        ["S...GGGG...S", ".SGGGGGGGGS.", "GGGGBBGGBGGG", ".GGGGGGGGGG.", "..GGPPPPGG..", ".G.G..G..G.."],
        ["S...GGGG...S", ".SGGGGGGGGS.", "GGGGBBGGBGGG", ".GGGGGGGGGG.", "...GPPPGG...", "..GG..GG...."],
        ["S...GGGG...S", ".SGGGGGGGGS.", "GGGGBBGGBGGG", "..GGGGGGGG..", "..GGPPPPG...", "...G.G..GG.."],
        ["S...GGGG...S", ".SGGGGGGGGS.", "GGGGBBGGBGGG", ".GGGGGGGGGG.", "..GGPPPPGG..", ".GG...G.G..."],
      ],
    },
    {
      id: "06",
      name: "sneaksnout",
      frames: [
        ["...S.......", "..SGGGS....", ".SGGBBGGG..", "SGGGPPPGG..", "..GGPPG....", ".G..G.G...."],
        ["...S.......", "..SGGGS....", ".SGGBBGGG..", "SGGGPPPG...", "..GPPGG....", "...GG......"],
        ["...S.......", "..SGGGS....", ".SGGBBGGG..", "SGGGPPPGG..", ".GGPPG.....", "..G.G..G..."],
        ["...S.......", "..SGGGS....", ".SGGBBGGG..", "SGGGPPPG...", "..GGPPG....", ".G...G....."],
      ],
    },
    {
      id: "07",
      name: "rogue dagger",
      frames: [
        ["..S.....MM...", ".SGGGGGGMM...", "SGGGBBGGGM...", ".GGPPPPGMM...", "..GGPPGG.....", ".G..G.G......"],
        ["..S.....MM...", ".SGGGGGGMM...", "SGGGBBGGGM...", ".GGPPPPGMM...", "..GPPGG......", "...GG........"],
        ["..S.....MM...", ".SGGGGGGMM...", "SGGGBBGGGM...", "GGGPPPPGGM...", "..GGPPG......", ".G.G..G......"],
        ["..S.....MM...", ".SGGGGGGMM...", "SGGGBBGGGM...", ".GGPPPPGMM...", "..GGPPGG.....", ".G....G......"],
      ],
    },
    {
      id: "08",
      name: "scar hood",
      frames: [
        ["..P....P..", ".PGGGGGGP.", "PGGBMBGGGP", ".GGGPPGGG.", "..GGPPGG..", ".G.G..G..."],
        ["..P....P..", ".PGGGGGGP.", "PGGBMBGGGP", ".GGGPPGGG.", "...GPPG...", "..GG..GG.."],
        ["..P....P..", ".PGGGGGGP.", "PGGBMBGGGP", ".GGGPPGGG.", ".GGPPPG...", "...G.G..G."],
        ["..P....P..", ".PGGGGGGP.", "PGGBMBGGGP", ".GGGPPGGG.", "..GGPPGG..", ".G...G.G.."],
      ],
    },
    {
      id: "09",
      name: "squat bruiser",
      frames: [
        [".SGGGGGS.", "SGGBBGGGS", "GGGPPPGGG", ".GGPPPGG.", "G.G...G.G"],
        [".SGGGGGS.", "SGGBBGGGS", "GGGPPPGGG", "..GGPG...", ".GG..GG.."],
        [".SGGGGGS.", "SGGBBGGGS", "GGGPPPGGG", ".GGPPGG..", "..G.G..G."],
        [".SGGGGGS.", "SGGBBGGGS", "GGGPPPGGG", "..GGPPG..", ".G...G.G."],
      ],
    },
    {
      id: "10",
      name: "deluxe goblin",
      frames: [
        ["..S....S....", ".SGGGGGGGS..", "SGGGBMMBGGGS", ".GGGGGGGGGG.", "..GGPPPPGG..", "...GPPG.....", ".G.G..G..G.."],
        ["..S....S....", ".SGGGGGGGS..", "SGGGBMMBGGGS", ".GGGGGGGGGG.", "...GGPPGG...", "....GGG.....", "..GG..GG...."],
        ["..S....S....", ".SGGGGGGGS..", "SGGGBMMBGGGS", ".GGGGGGGGGG.", "..GGPPPPG...", "...GPPGG....", ".G..G..G.G.."],
        ["..S....S....", ".SGGGGGGGS..", "SGGGBMMBGGGS", ".GGGGGGGGGG.", "...GPPPGG...", "..GGPG......", ".G.G...G...."],
      ],
    },
    {
      id: "11",
      name: "lean sneak",
      frames: [
        ["..S.....", ".SGGG...", "SGGBBG..", ".GGPPGG.", "..GPPG..", ".G..G.G."],
        ["..S.....", ".SGGG...", "SGGBBG..", ".GGPPGG.", "..GGPG..", "..GGGG.."],
        ["..S.....", ".SGGG...", "SGGBBG..", ".GGPPG..", "...GPGG.", ".G.G..G."],
        ["..S.....", ".SGGG...", "SGGBBG..", ".GGPPGG.", "..GPPGG.", ".G...G.."],
      ],
    },
    {
      id: "12",
      name: "pickpocket",
      frames: [
        ["...S.....", "..SGGG...", ".SGGBBG..", "SGGPPPGG.", "..GPPPG..", ".G..G.G.."],
        ["...S.....", "..SGGG...", ".SGGBBG..", "SGGPPPG..", "..GGPPG..", "...GGGG.."],
        ["...S.....", "..SGGG...", ".SGGBBG..", "SGGPPPGG.", ".GGPPG...", "..G.G..G."],
        ["...S.....", "..SGGG...", ".SGGBBG..", ".GGPPPGG.", "..GPPGG..", ".G...G.G."],
      ],
    },
    {
      id: "13",
      name: "mini nib",
      frames: [
        [".S.....", "SGGG...", "GGBBG..", ".GPPGG.", "..GPG..", ".G..G.."],
        [".S.....", "SGGG...", "GGBBG..", ".GPPGG.", "..GGG..", "..G.G.."],
        [".S.....", "SGGG...", "GGBBG..", ".GGPG..", "...PPGG", ".G.G..."],
        [".S.....", "SGGG...", "GGBBG..", ".GPPGG.", "..GPG..", ".G...G."],
      ],
    },
    {
      id: "14",
      name: "crouch hop",
      frames: [
        ["..S....", ".SGGG..", "SGGBGG.", ".GPPPG.", "..GGG..", ".G.G..."],
        ["..S....", ".SGGG..", "SGGBGG.", ".GPPPG.", "...GG..", "..G.G.."],
        ["..S....", ".SGGG..", "SGGBGG.", ".GGPPG.", "..GPG..", ".G..G.."],
        ["..S....", ".SGGG..", "SGGBGG.", ".GPPPG.", "..GGPG.", ".G.G..."],
      ],
    },
    {
      id: "15",
      name: "hunched runner",
      frames: [
        ["...S....", "..SGGG..", ".SGGBGG.", "SGGPPPG.", "..GPPGG.", ".G.G..G."],
        ["...S....", "..SGGG..", ".SGGBGG.", "SGGPPPG.", "...GGPG.", "..GGG..."],
        ["...S....", "..SGGG..", ".SGGBGG.", ".GGPPPGG", "..GPPG..", ".G..G.G."],
        ["...S....", "..SGGG..", ".SGGBGG.", "SGGPPPG.", "..GGPGG.", ".G...G.."],
      ],
    },
    {
      id: "16",
      name: "satchel scout",
      frames: [
        ["..S......", ".SGGG....", "SGGBBG...", ".GGPPGGMM", "..GPPGMM.", ".G..G...."],
        ["..S......", ".SGGG....", "SGGBBG...", ".GGPPGGMM", "..GGPGMM.", "..GG....."],
        ["..S......", ".SGGG....", "SGGBBG...", ".GGPPG.MM", "...GPGGMM", ".G.G....."],
        ["..S......", ".SGGG....", "SGGBBG...", ".GGPPGGMM", "..GPPGMM.", ".G...G..."],
      ],
    },
    {
      id: "17",
      name: "hood pip",
      frames: [
        ["..P....", ".PGGG..", "PGGBG..", ".GPPGG.", "..GPG..", ".G.G..."],
        ["..P....", ".PGGG..", "PGGBG..", ".GPPGG.", "..GGG..", "..G.G.."],
        ["..P....", ".PGGG..", "PGGBG..", ".GGPG..", "...PPGG", ".G..G.."],
        ["..P....", ".PGGG..", "PGGBG..", ".GPPGG.", "..GPG..", ".G...G."],
      ],
    },
    {
      id: "18",
      name: "low bruiser",
      frames: [
        [".SGGGG..", "SGGBBG..", "GGPPPPG.", ".GGPPGG.", "G.G..G.."],
        [".SGGGG..", "SGGBBG..", "GGPPPPG.", "..GPPG..", ".GGGG..."],
        [".SGGGG..", "SGGBBG..", "GGPPPPGG", ".GGPPG..", "..G.G.G."],
        [".SGGGG..", "SGGBBG..", "GGPPPPG.", "..GGPGG.", ".G...G.."],
      ],
    },
    {
      id: "19",
      name: "crooknose",
      frames: [
        ["...S.....", "..SGGG...", ".SGBBGG..", "SGGPPPGG.", "..GGPG...", ".G..G.G.."],
        ["...S.....", "..SGGG...", ".SGBBGG..", "SGGPPPG..", "..GPPG...", "...GGGG.."],
        ["...S.....", "..SGGG...", ".SGBBGG..", ".GGPPPGG.", "..GPGG...", ".G.G..G.."],
        ["...S.....", "..SGGG...", ".SGBBGG..", "SGGPPPGG.", "..GGPGG..", ".G...G..."],
      ],
    },
    {
      id: "20",
      name: "compact deluxe",
      frames: [
        ["..S..S..", ".SGGGGG.", "SGGBMBGG", ".GGPPPG.", "..GPPGG.", ".G..G.G."],
        ["..S..S..", ".SGGGGG.", "SGGBMBGG", ".GGPPPG.", "..GGPG..", "..GGGG.."],
        ["..S..S..", ".SGGGGG.", "SGGBMBGG", ".GGPPPG.", ".GGPPG..", ".G.G..G."],
        ["..S..S..", ".SGGGGG.", "SGGBMBGG", ".GGPPPG.", "..GPPGG.", ".G...G.."],
      ],
    },
  ]

  function normalizeRunnerVariantId(value: string | undefined) {
    const cleaned = value?.trim().replace(/^v/i, "")
    const numeric = Number(cleaned)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= runnerVariants.length) {
      return String(numeric).padStart(2, "0")
    }
    return "12"
  }

  function normalizeRunnerFrames(frames: string[][]) {
    const height = Math.max(...frames.map((frame) => frame.length))
    const width = Math.max(...frames.flatMap((frame) => frame.map((row) => row.length)))
    return frames.map((frame) => Array.from({ length: height }, (_, rowIndex) => (frame[rowIndex] ?? "").padEnd(width, ".")))
  }

  const selectedRunnerVariantId = normalizeRunnerVariantId(process.env.CODEGOBLIN_FOOTER_VARIANT)
  const selectedRunnerVariant =
    runnerVariants.find((variant) => variant.id === selectedRunnerVariantId) ??
    runnerVariants.find((variant) => variant.id === "12") ??
    runnerVariants[0]
  const rightRunnerFrames = normalizeRunnerFrames(selectedRunnerVariant.frames)
  const leftRunnerFrames = rightRunnerFrames.map((frame) => frame.map((runnerRow) => [...runnerRow].reverse().join("")))

  const spriteHeight = rightRunnerFrames[0]?.length ?? 0
  const spriteWidth = Math.max(...rightRunnerFrames.flatMap((frame) => frame.map((runnerRow) => runnerRow.length)))
  const laneCells = () => {
    const availableChars = Math.max(12, dimensions().width - 8)
    return Math.max(spriteWidth + 4, Math.min(32, Math.floor(availableChars / 2)))
  }
  const laneWidth = () => laneCells() * 2
  const travelSpan = () => Math.max(0, laneCells() - spriteWidth)
  const cycleLength = () => Math.max(1, travelSpan() * 2)
  const movingRight = () => travelSpan() === 0 || (tick() % cycleLength()) < travelSpan()
  const spriteOffset = () => {
    const span = travelSpan()
    if (span <= 0) return 0
    const phase = tick() % (span * 2)
    return phase <= span ? phase : span * 2 - phase
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
    const frameSet = movingRight() ? rightRunnerFrames : leftRunnerFrames
    const frame = frameSet[tick() % frameSet.length] ?? frameSet[0] ?? []
    const spriteRow = frame[rowIndex] ?? "".padEnd(spriteWidth, ".")
    const offset = spriteOffset()
    const trailStart = movingRight()
      ? Math.max(0, offset - 2)
      : Math.min(laneCells(), offset + spriteWidth)
    const trailEnd = movingRight()
      ? Math.max(0, offset)
      : Math.min(laneCells(), offset + spriteWidth + 2)
    const cells: JSX.Element[] = []

    for (let cell = 0; cell < laneCells(); cell++) {
      const spriteColumn = cell - offset
      const char = spriteColumn >= 0 && spriteColumn < spriteRow.length ? spriteRow[spriteColumn] : "."

      if (char === "G") {
        cells.push(<text fg={skinColor}>██</text>)
      } else if (char === "S") {
        cells.push(<text fg={shadowColor}>██</text>)
      } else if (char === "P") {
        cells.push(<text fg={vestColor}>██</text>)
      } else if (char === "B") {
        cells.push(<text fg={eyeColor}>██</text>)
      } else if (char === "M") {
        cells.push(<text fg={props.theme.textMuted}>██</text>)
      } else if (rowIndex === spriteHeight - 1 && cell >= trailStart && cell < trailEnd) {
        cells.push(<text fg={shadowColor}>░░</text>)
      } else {
        cells.push(<text>  </text>)
      }
    }

    return cells
  }

  return (
    <box flexDirection="column" alignItems="center" width="100%" flexShrink={0}>
      {Array.from({ length: spriteHeight }, (_, rowIndex) => (
        <box flexDirection="row" width={laneWidth()}>
          {renderRunnerRow(rowIndex)}
        </box>
      ))}
      <box flexDirection="row" width={laneWidth()}>
        <text fg={shadowColor}>{"▁".repeat(laneWidth())}</text>
      </box>
    </box>
  )
}

function isFooterAnimationEnabled(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

let once = false
const placeholder = {
  normal: ["Dig up a buried TODO", "Map out this project's stack", "Mend the broken tests"],
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

  const bind = (runnerPrompt: PromptRef | undefined) => {
    setRef(runnerPrompt)
    promptRef.set(runnerPrompt)
    if (once || !runnerPrompt) return
    if (route.prompt) {
      runnerPrompt.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    runnerPrompt.set({ input: args.prompt, parts: [] })
    once = true
  }

  createEffect(() => {
    const runnerPrompt = ref()
    if (sent) return
    if (!runnerPrompt) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (runnerPrompt.current.input !== args.prompt) return
    sent = true
    runnerPrompt.submit()
  })

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={2} minHeight={0} />
        <box flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            <TuiGoblinHeader theme={theme} />
          </TuiPluginRuntime.Slot>
        </box>
        <box flexGrow={3} minHeight={0} />
        {showFooterAnimation ? <TuiGoblinRunner theme={theme} /> : null}
        <TuiPluginRuntime.Slot name="home_bottom" />
        <box height={1} minHeight={0} flexShrink={0} />
        <box width="100%" maxWidth={130} minHeight={3} zIndex={1000} flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<TuiPluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
          </TuiPluginRuntime.Slot>
        </box>
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
