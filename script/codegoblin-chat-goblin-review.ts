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

function cellClass(char: string) {
  if (char === ".") return "cell empty"
  return `cell ${char}`
}

function renderFrame(frame: string[], label: string) {
  const rows = normalizeFrame(frame)
  const width = rows[0]?.length ?? 0
  const cells = rows
    .flatMap((row) => [...row].map((char) => `<span class="${cellClass(char)}"></span>`))
    .join("")

  return `<div class="frame-block">
    <div class="frame-label">${label}</div>
    <div class="pixel-grid" style="grid-template-columns: repeat(${width}, var(--cell));">${cells}</div>
  </div>`
}

function renderVariant(variant: ChatGoblinVariant) {
  return `<section class="card">
    <h2>${variant.id}. ${variant.name}</h2>
    <div class="frames">${variant.frames.map((frame, index) => renderFrame(frame, `f${index + 1}`)).join("")}</div>
  </section>`
}

function renderBudgetMeter(visible: number, stable = visible, total = 12) {
  return `<div class="budget-meter">${Array.from({ length: total }, (_, index) => {
    if (index < visible) return '<span class="meter-cell full"></span>'
    if (index < stable) return '<span class="meter-cell bite"></span>'
    return '<span class="meter-cell empty"></span>'
  }).join("")}</div>`
}

function renderBudgetScene(
  variant: ChatGoblinVariant,
  options: { label: string; headline: string; detail: string; frameIndex: number; visible: number; stable?: number },
) {
  return `<section class="card budget-scene">
    <h2>${options.label}</h2>
    <div class="budget-headline">${options.headline}</div>
    ${renderBudgetMeter(options.visible, options.stable ?? options.visible)}
    <div class="budget-detail">${options.detail}</div>
    <div class="frames">${renderFrame(variant.frames[options.frameIndex] ?? variant.frames[0] ?? [], `${variant.id}. ${variant.name}`)}</div>
  </section>`
}

const source = await Bun.file(sidebarPath).text()
const variants = parseVariants(source)
if (variants.length === 0) throw new Error("No chat goblin variants found")
const originalVariants = variants.filter((variant) => Number(variant.id) <= 20)
const menuBodyVariants = variants.filter((variant) => Number(variant.id) > 20)
const favoriteBudgetVariants = ["40", "39", "30"]
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
        --cell: 8px;
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
      .pixel-grid {
        display: grid;
        gap: 1px;
        padding: 8px;
        background: #020403;
        border: 1px solid #102414;
        border-radius: 8px;
      }
      .cell { width: var(--cell); height: var(--cell); background: transparent; }
      .cell.G, .micro-char.G, .micro-char.S, .micro-char.A { background: var(--skin); color: var(--skin); }
      .cell.S { background: var(--shadow); }
      .cell.P, .micro-char.P { background: var(--vest); color: var(--vest); }
      .cell.B { background: var(--mouth); }
      .cell.M, .micro-char.M { background: var(--shadow); color: var(--shadow); }
      .cell.T, .micro-char.T { background: var(--token); color: var(--token); }
      .cell.W { background: var(--teeth); }
      .empty { opacity: 0; }
      .budget-samples {
        margin-bottom: 18px;
      }
      .budget-scene {
        display: grid;
        gap: 10px;
      }
      .budget-headline {
        color: #f0ffe9;
        font-size: 13px;
      }
      .budget-detail {
        color: var(--muted);
        font-size: 12px;
      }
      .budget-meter {
        display: flex;
        gap: 4px;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid #102414;
        background: #020403;
      }
      .meter-cell {
        width: 16px;
        height: 12px;
        border-radius: 2px;
        background: #1f3221;
      }
      .meter-cell.full {
        background: var(--token);
        box-shadow: 0 0 10px rgba(255, 196, 91, 0.25);
      }
      .meter-cell.bite {
        background: #071409;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>CodeGoblin chat goblin review</h1>
      <p>${variants.length} right-sidebar variants parsed from sidebar.tsx. Top cards preview the new budget-chewing direction with favorites 40, 39, and 30.</p>
    </header>
    <main>
      <h2 class="section-title">Budget chewing preview</h2>
      <div class="grid budget-samples">${[
        favoriteBudgetVariants[0]
          ? renderBudgetScene(favoriteBudgetVariants[0], {
              label: "Idle stash · 40",
              headline: "token stash",
              detail: "18,200 tokens · 14% ctx · spent $0.0124",
              frameIndex: 0,
              visible: 10,
            })
          : "",
        favoriteBudgetVariants[1]
          ? renderBudgetScene(favoriteBudgetVariants[1], {
              label: "Chewing pass · 39",
              headline: "goblin chewing budget",
              detail: "18,200 tokens · 14% ctx · spent $0.0124",
              frameIndex: 1,
              visible: 7,
              stable: 10,
            })
          : "",
        favoriteBudgetVariants[2]
          ? renderBudgetScene(favoriteBudgetVariants[2], {
              label: "Wide-mouth bite · 30",
              headline: "goblin chewing budget",
              detail: "18,200 tokens · 14% ctx · spent $0.0124",
              frameIndex: 1,
              visible: 8,
              stable: 10,
            })
          : "",
      ].join("")}</div>
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