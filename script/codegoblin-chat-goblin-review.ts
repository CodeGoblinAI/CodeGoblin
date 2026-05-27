import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

type GoblinFrameCycle = [string, string, string, string]
type GoblinRow = string | GoblinFrameCycle

interface ChatGoblinVariant {
  id: string
  name: string
  frames: string[][]
}

const DEFAULT_SIDEBAR_COLS = 46

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sidebarPath = join(repoRoot, "packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx")
const outputDir = join(repoRoot, "codegoblin-generated")
const outputPath = join(outputDir, "codegoblin-chat-goblin-review.html")

function cycle(row: GoblinRow): GoblinFrameCycle {
  return typeof row === "string" ? [row, row, row, row] : row
}

function createFrames(rows: GoblinRow[]) {
  const cycledRows = rows.map(cycle)
  return Array.from({ length: 4 }, (_, frameIndex) => cycledRows.map((row) => row[frameIndex]))
}

function findMatchingBracket(source: string, start: number) {
  let depth = 0
  let quote: string | undefined
  let escaped = false

  for (let index = start; index < source.length; index++) {
    const char = source[index]

    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) quote = undefined
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "[") depth++
    if (char === "]") {
      depth--
      if (depth === 0) return index
    }
  }

  throw new Error("Could not find matching bracket while parsing chat goblin art")
}

function parseVariants(source: string) {
  const variants: ChatGoblinVariant[] = []
  let cursor = 0
  const sharedRows = {
    menuHeadSmall: parseSharedRows(source, "menuHeadSmall"),
    menuHeadWide: parseSharedRows(source, "menuHeadWide"),
    menuHeadSlim: parseSharedRows(source, "menuHeadSlim"),
    profileHead: parseSharedRows(source, "profileHead"),
  }

  while (true) {
    const start = source.indexOf("createChatGoblinVariant(", cursor)
    if (start === -1) break

    const header = source.slice(start, start + 120)
    const match = header.match(/createChatGoblinVariant\("(\d+)",\s*"([^"]+)"/)
    if (!match) {
      cursor = start + 1
      continue
    }

    const rowsStart = source.indexOf("[", start)
    const rowsEnd = findMatchingBracket(source, rowsStart)
    const rowsExpression = source.slice(rowsStart, rowsEnd + 1)
    const rows = Function(
      "menuHeadSmall",
      "menuHeadWide",
      "menuHeadSlim",
      "profileHead",
      `return ${rowsExpression}`,
    )(
      sharedRows.menuHeadSmall,
      sharedRows.menuHeadWide,
      sharedRows.menuHeadSlim,
      sharedRows.profileHead,
    ) as GoblinRow[]

    variants.push({
      id: match[1]!,
      name: match[2]!,
      frames: createFrames(rows),
    })
    cursor = rowsEnd + 1
  }

  return variants
}

function parseSharedRows(source: string, name: string) {
  const start = source.indexOf(`const ${name}`)
  if (start === -1) return []
  const assignmentStart = source.indexOf("=", start)
  const rowsStart = source.indexOf("[", assignmentStart)
  const rowsEnd = findMatchingBracket(source, rowsStart)
  return Function(`return ${source.slice(rowsStart, rowsEnd + 1)}`)() as GoblinRow[]
}

function normalizeFrame(frame: string[]) {
  const width = Math.max(...frame.map((row) => row.length))
  return frame.map((row) => row.padEnd(width, "."))
}

function parseSidebarWidth(source: string) {
  const match = source.match(/export const SESSION_SIDEBAR_WIDTH = (\d+)/)
  return Number(match?.[1] ?? DEFAULT_SIDEBAR_COLS)
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function fillForChar(char: string) {
  if (char === "G") return "#9adb35"
  if (char === "S") return "#777d87"
  if (char === "P") return "#8250df"
  if (char === "B") return "#000000"
  if (char === "M") return "#777d87"
  if (char === "T") return "#ffc45b"
  if (char === "W") return "#eaf7e7"
  return undefined
}

function renderSprite(frame: string[], className?: string) {
  const rows = normalizeFrame(frame)
  const width = rows[0]?.length ?? 0
  const height = rows.length
  const rects = rows
    .flatMap((row, rowIndex) =>
      [...row].flatMap((char, colIndex) => {
        const fill = fillForChar(char)
        if (!fill) return []
        return [`<rect x="${colIndex * 2}" y="${rowIndex}" width="2" height="1" fill="${fill}" />`]
      }),
    )
    .join("")
  const classes = ["sprite-svg", className].filter(Boolean).join(" ")

  return `<svg
    class="${classes}"
    viewBox="0 0 ${width * 2} ${height}"
    style="width: calc(${width} * var(--logical-cell-w)); height: calc(${height} * var(--logical-cell-h));"
    xmlns="http://www.w3.org/2000/svg"
    shape-rendering="crispEdges"
    preserveAspectRatio="xMidYMid meet"
    aria-hidden="true"
  >${rects}</svg>`
}

function renderFrame(frame: string[], label: string) {
  const rows = normalizeFrame(frame)
  const width = rows[0]?.length ?? 0
  const height = rows.length

  return `<div class="frame-block">
    <div class="frame-label">${escapeHtml(label)} · ${width * 2} cols × ${height} rows</div>
    <div class="sprite-frame">${renderSprite(rows)}</div>
  </div>`
}

function renderVariant(variant: ChatGoblinVariant) {
  return `<section class="card">
    <h2>${variant.id}. ${variant.name}</h2>
    <div class="frames">${variant.frames.map((frame, index) => renderFrame(frame, `f${index + 1}`)).join("")}</div>
  </section>`
}

function renderNativeSidebarScene(
  variant: ChatGoblinVariant,
  options: {
    label: string
    detail: string
    frameIndex: number
    spend: string
    last: string
    status: string
    context: string
  },
) {
  const frame = variant.frames[options.frameIndex] ?? variant.frames[0] ?? []
  return `<section class="card companion-scene">
    <h2>${escapeHtml(options.label)}</h2>
    <div class="companion-headline">${escapeHtml(options.detail)}</div>
    <div class="native-sidebar">
      <div class="native-sidebar-copy">
        <div class="native-sidebar-title">CodeGoblin companion</div>
        <div class="native-sidebar-row"><span>spend :</span><b>${escapeHtml(options.spend)}</b></div>
        <div class="native-sidebar-row"><span>last&nbsp;&nbsp;:</span><b>${escapeHtml(options.last)}</b></div>
        <div class="native-sidebar-status">${escapeHtml(options.status)}</div>
        <div class="native-sidebar-context">${escapeHtml(options.context)}</div>
      </div>
      <div class="native-sidebar-sprite">${renderSprite(frame, "native-sprite")}</div>
    </div>
  </section>`
}

const source = await Bun.file(sidebarPath).text()
const sidebarCols = parseSidebarWidth(source)
const variants = parseVariants(source)
if (variants.length === 0) throw new Error("No chat goblin variants found")
const originalVariants = variants.filter((variant) => Number(variant.id) <= 20)
const menuBodyVariants = variants.filter((variant) => Number(variant.id) > 20)
const focusBodyVariants = ["40", "30", "39"]
  .map((id) => variants.find((variant) => variant.id === id))
  .filter(Boolean) as ChatGoblinVariant[]

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeGoblin chat goblin review</title>
    <style>
      :root {
        --bg: #050806;
        --panel: #07140b;
        --panel-2: #0b1b10;
        --text: #d6f5d2;
        --muted: #90a08f;
        --skin: #9adb35;
        --shadow: #777d87;
        --vest: #8250df;
        --mouth: #000000;
        --token: #ffc45b;
        --teeth: #eaf7e7;
        --terminal-col-w: 7px;
        --terminal-row-h: 15px;
        --logical-cell-w: calc(var(--terminal-col-w) * 2);
        --logical-cell-h: var(--terminal-row-h);
        --sidebar-cols: ${sidebarCols};
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      header {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 18px 22px;
        background: linear-gradient(180deg, #0a170d, rgba(5, 8, 6, 0.92));
        border-bottom: 1px solid #18391d;
      }
      h1, h2, p { margin: 0; }
      h1 { font-size: 18px; }
      p { color: var(--muted); margin-top: 6px; }
      main { padding: 18px; }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 16px;
      }
      .section-title {
        margin: 24px 0 12px;
        color: #f0ffe9;
        font-size: 16px;
      }
      .card {
        background: var(--panel);
        border: 1px solid #143319;
        border-radius: 14px;
        padding: 14px;
        box-shadow: 0 10px 35px rgba(0, 0, 0, 0.24);
      }
      .card h2 { font-size: 14px; color: #f0ffe9; margin-bottom: 12px; }
      .frames { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
      .frame-block { display: grid; gap: 5px; }
      .frame-label { color: var(--muted); font-size: 11px; }
      .sprite-frame {
        display: inline-flex;
        padding: 8px;
        background: #020403;
        border: 1px solid #102414;
        border-radius: 8px;
      }
      .sprite-svg {
        display: block;
      }
      .companion-samples {
        margin-bottom: 18px;
      }
      .companion-scene {
        display: grid;
        gap: 10px;
      }
      .companion-headline {
        color: #f0ffe9;
        font-size: 13px;
      }
      .section-copy {
        color: var(--muted);
        font-size: 12px;
        margin: -2px 0 12px;
      }
      .native-sidebar {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        width: calc(var(--terminal-col-w) * var(--sidebar-cols));
        min-height: calc(var(--terminal-row-h) * 24);
        box-sizing: border-box;
        padding: calc(var(--terminal-row-h) * 0.75) calc(var(--terminal-col-w) * 2);
        border-radius: 12px;
        border: 1px solid #102414;
        background: #020403;
      }
      .native-sidebar-copy {
        display: grid;
        gap: 2px;
        font-size: 13px;
        line-height: 1.25;
      }
      .native-sidebar-title {
        color: #f0ffe9;
        font-weight: 700;
        margin-bottom: 2px;
      }
      .native-sidebar-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        color: var(--muted);
      }
      .native-sidebar-row b {
        color: var(--token);
      }
      .native-sidebar-status {
        color: var(--token);
        margin-top: 2px;
      }
      .native-sidebar-context {
        color: var(--muted);
      }
      .native-sidebar-sprite {
        display: flex;
        justify-content: center;
        align-items: flex-end;
        padding-top: calc(var(--terminal-row-h) * 1.5);
      }
      .native-sprite {
        flex: 0 0 auto;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>CodeGoblin chat goblin review</h1>
      <p>${variants.length} right-sidebar variants parsed from sidebar.tsx. Sprites below now render as deterministic SVG rectangles from the exact art arrays, with native sidebar width shown first.</p>
    </header>
    <main>
      <h2 class="section-title">Native sidebar footprint</h2>
      <p class="section-copy">Shape first: these cards show the goblin at the actual ${sidebarCols}-column sidebar width. Native cards are showing frame 1, so you can compare them directly against a CLI run locked to frame 1.</p>
      <div class="grid companion-samples">${[
        focusBodyVariants[0]
          ? renderNativeSidebarScene(focusBodyVariants[0], {
              label: "40. menu clean body",
              detail: "baseline body at native sidebar size",
              frameIndex: 0,
              spend: "$0.00",
              last: "waiting",
              status: "ready with pockets empty",
              context: "16,615 tokens · 8% ctx",
            })
          : "",
        focusBodyVariants[1]
          ? renderNativeSidebarScene(focusBodyVariants[1], {
              label: "30. menu wide arms",
              detail: "same sidebar footprint, alternate body shape",
              frameIndex: 0,
              spend: "$0.00",
              last: "waiting",
              status: "ready with pockets empty",
              context: "16,615 tokens · 8% ctx",
            })
          : "",
        focusBodyVariants[2]
          ? renderNativeSidebarScene(focusBodyVariants[2], {
              label: "39. menu token lunge",
              detail: "forward-leaning body candidate at native scale",
              frameIndex: 0,
              spend: "$0.00",
              last: "waiting",
              status: "ready with pockets empty",
              context: "16,615 tokens · 8% ctx",
            })
          : "",
      ].join("")}</div>
      <h2 class="section-title">Zoomed sprite frames</h2>
      <p class="section-copy">These are the exact frame rectangles from the sidebar source, just enlarged for inspection.</p>
      <h2 class="section-title">New menu-head/body variants (${menuBodyVariants.length})</h2>
      <div class="grid new-menu-batch">${menuBodyVariants.map(renderVariant).join("")}</div>
      <h2 class="section-title">Earlier sidebar experiments (${originalVariants.length})</h2>
      <div class="grid">${originalVariants.map(renderVariant).join("")}</div>
    </main>
  </body>
</html>`

await mkdir(outputDir, { recursive: true })
await writeFile(outputPath, html)

console.log(`Wrote ${outputPath}`)
console.log(pathToFileURL(outputPath).href)