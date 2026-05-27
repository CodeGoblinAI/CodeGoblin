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

const bottomFrames = [
  ["S.S.T.", "GBG.T.", ".P.G.."],
  ["S.S..T", "GBGG.T", ".P.G.."],
  ["S.S...", "GBG.M.", ".P.G.."],
  ["S.S...", "GBGM..", ".P.G.."],
]

function renderMicroFrame(frame: string[], label: string) {
  const rows = normalizeFrame(frame)
  const width = rows[0]?.length ?? 0
  const cells = rows
    .flatMap((row) => [...row].map((char) => `<span class="${char === "B" ? "cell empty" : cellClass(char)}"></span>`))
    .join("")

  return `<div class="micro-frame"><div class="frame-label">${label}</div><div class="micro-grid" style="grid-template-columns: repeat(${width}, var(--micro-cell));">${cells}</div></div>`
}

const source = await Bun.file(sidebarPath).text()
const variants = parseVariants(source)
if (variants.length === 0) throw new Error("No chat goblin variants found")
const originalVariants = variants.filter((variant) => Number(variant.id) <= 20)
const menuBodyVariants = variants.filter((variant) => Number(variant.id) > 20)

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
        --micro-cell: 7px;
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
      .card, .bottom-card {
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
      .bottom-card { margin-bottom: 18px; }
      .chat-mock {
        margin-top: 12px;
        height: 160px;
        border: 1px solid #15391a;
        border-radius: 10px;
        background: #020403;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        padding: 12px;
      }
      .prompt-bar {
        height: 44px;
        background: #071409;
        border-left: 4px solid #54ff66;
        margin-bottom: 8px;
      }
      .micro-row { display: flex; gap: 14px; align-items: flex-end; }
      .micro-grid {
        display: grid;
        gap: 1px;
        padding: 5px;
        background: #020403;
        border: 1px solid #102414;
        border-radius: 6px;
      }
      .micro-grid .cell { width: var(--micro-cell); height: var(--micro-cell); }
      .micro-grid .cell.S { background: var(--skin); }
    </style>
  </head>
  <body>
    <header>
      <h1>CodeGoblin chat goblin review</h1>
      <p>${variants.length} right-sidebar variants parsed from sidebar.tsx. Bottom micro-goblin is shown at actual bottom-left scale.</p>
    </header>
    <main>
      <section class="bottom-card">
        <h2>Bottom-left micro goblin</h2>
        <p>Small text-scale sprite under the prompt, left aligned.</p>
        <div class="chat-mock">
          <div class="prompt-bar"></div>
          <div class="micro-row">${bottomFrames.map((frame, index) => renderMicroFrame(frame, `f${index + 1}`)).join("")}</div>
        </div>
      </section>
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