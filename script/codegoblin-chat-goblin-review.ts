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

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function terminalCell(char: string) {
  if (char === ".") return '<span class="term-cell empty"></span>'
  return `<span class="term-cell ${char}"></span>`
}

function renderFrame(frame: string[], label: string) {
  const rows = normalizeFrame(frame)
  const width = rows[0]?.length ?? 0
  const cells = rows.flatMap((row) => [...row].map(terminalCell)).join("")

  return `<div class="frame-block">
    <div class="frame-label">${escapeHtml(label)}</div>
    <div class="terminal-grid" style="grid-template-columns: repeat(${width}, var(--logical-cell-w));">${cells}</div>
  </div>`
}

function renderVariant(variant: ChatGoblinVariant) {
  return `<section class="card">
    <h2>${variant.id}. ${variant.name}</h2>
    <div class="frames">${variant.frames.map((frame, index) => renderFrame(frame, `f${index + 1}`)).join("")}</div>
  </section>`
}

function renderCompanionScene(
  variant: ChatGoblinVariant,
  options: { label: string; headline: string; action: string; frameIndex: number; spend: string; last: string },
) {
  return `<section class="card companion-scene">
    <h2>${escapeHtml(options.label)}</h2>
    <div class="companion-headline">${escapeHtml(options.headline)}</div>
    <div class="ledger"><span>spend :</span><b>${escapeHtml(options.spend)}</b></div>
    <div class="ledger"><span>last&nbsp;&nbsp;:</span><b>${escapeHtml(options.last)}</b></div>
    <div class="companion-action">${escapeHtml(options.action)}</div>
    <div class="companion-detail">CLI cell-ratio preview · one art cell = two terminal columns</div>
    <div class="frames">${renderFrame(variant.frames[options.frameIndex] ?? variant.frames[0] ?? [], `${variant.id}. ${variant.name}`)}</div>
  </section>`
}

const source = await Bun.file(sidebarPath).text()
const variants = parseVariants(source)
if (variants.length === 0) throw new Error("No chat goblin variants found")
const originalVariants = variants.filter((variant) => Number(variant.id) <= 20)
const menuBodyVariants = variants.filter((variant) => Number(variant.id) > 20)
const favoriteCompanionVariants = ["40", "30", "39", "40"]
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
      .terminal-grid {
        display: grid;
        gap: 0;
        width: max-content;
        padding: 8px;
        background: #020403;
        border: 1px solid #102414;
        border-radius: 8px;
        line-height: 0;
      }
      .term-cell {
        display: block;
        width: var(--logical-cell-w);
        height: var(--logical-cell-h);
      }
      .term-cell.G { background: var(--skin); }
      .term-cell.S { background: var(--shadow); }
      .term-cell.P { background: var(--vest); }
      .term-cell.B { background: var(--mouth); }
      .term-cell.M { background: var(--shadow); }
      .term-cell.T { background: var(--token); }
      .term-cell.W { background: var(--teeth); }
      .term-cell.empty { background: transparent; }
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
      .companion-detail {
        color: var(--muted);
        font-size: 12px;
      }
      .ledger {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 6px 8px;
        border-radius: 10px;
        border: 1px solid #102414;
        background: #020403;
        color: var(--muted);
      }
      .ledger b, .companion-action {
        color: var(--token);
      }
    </style>
  </head>
  <body>
    <header>
      <h1>CodeGoblin chat goblin review</h1>
      <p>${variants.length} right-sidebar variants parsed from sidebar.tsx. Preview cells now use terminal geometry: each art cell is two terminal columns wide by one terminal row tall.</p>
    </header>
    <main>
      <h2 class="section-title">Companion spend action iterations</h2>
      <div class="grid companion-samples">${[
        favoriteCompanionVariants[0]
          ? renderCompanionScene(favoriteCompanionVariants[0], {
              label: "01. pocket add",
              headline: "CodeGoblin adds spend",
              action: "pulls +$0.02 from his pocket",
              frameIndex: 0,
              spend: "$1.43",
              last: "+$0.02",
            })
          : "",
        favoriteCompanionVariants[1]
          ? renderCompanionScene(favoriteCompanionVariants[1], {
              label: "02. stamp spend",
              headline: "CodeGoblin adds spend",
              action: "stamps +$0.02 onto the spend slip",
              frameIndex: 1,
              spend: "$1.43",
              last: "+$0.02",
            })
          : "",
        favoriteCompanionVariants[2]
          ? renderCompanionScene(favoriteCompanionVariants[2], {
              label: "03. coin toss",
              headline: "CodeGoblin adds spend",
              action: "tosses +$0.02 into the spend pile",
              frameIndex: 2,
              spend: "$1.43",
              last: "+$0.02",
            })
          : "",
        favoriteCompanionVariants[3]
          ? renderCompanionScene(favoriteCompanionVariants[3], {
              label: "04. total replace",
              headline: "CodeGoblin adds spend",
              action: "replaces the total with $1.43",
              frameIndex: 3,
              spend: "$1.43",
              last: "+$0.02",
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