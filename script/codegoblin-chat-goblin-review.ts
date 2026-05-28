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

interface CompanionActionPreview {
  id: string
  name: string
  summary: string
  verdict: string
  recommended?: boolean
  note: string
  idleFrames: string[][]
  actionFrames: string[][]
}

interface CompanionActivityPreview {
  id: string
  name: string
  summary: string
  note: string
  frames: string[][]
}

interface CompanionActivityVariantDefinition {
  name: string
  summary: string
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

function staticRow(row: GoblinRow) {
  return typeof row === "string" ? row : row[0]
}

function createFrames(rows: GoblinRow[]) {
  const cycledRows = rows.map(cycle)
  return Array.from({ length: 4 }, (_, frameIndex) => cycledRows.map((row) => row[frameIndex]))
}

function normalizeFrames(frames: string[][]) {
  if (frames.length === 0) return []
  const height = Math.max(0, ...frames.map((frame) => frame.length))
  const width = Math.max(0, ...frames.flatMap((frame) => frame.map((row) => row.length)))
  return frames.map((frame) => Array.from({ length: height }, (_, rowIndex) => (frame[rowIndex] ?? "").padEnd(width, ".")))
}

function findMatchingDelimiter(source: string, start: number, open: string, close: string) {
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
    if (char === open) depth++
    if (char === close) {
      depth--
      if (depth === 0) return index
    }
  }

  throw new Error(`Could not find matching delimiter ${open}${close} while parsing chat goblin art`)
}

function findMatchingBracket(source: string, start: number) {
  return findMatchingDelimiter(source, start, "[", "]")
}

function findMatchingBrace(source: string, start: number) {
  return findMatchingDelimiter(source, start, "{", "}")
}

function findMatchingParen(source: string, start: number) {
  return findMatchingDelimiter(source, start, "(", ")")
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

function createCompanionFrame(...rows: string[]) {
  return rows
}

function parseCompanionIdleFrames(source: string, sharedRows: { menuHeadWide: GoblinRow[] }) {
  const start = source.indexOf("const companionIdleFrames")
  if (start === -1) return [] as string[][]
  const assignmentStart = source.indexOf("=", start)
  const exprStart = source.indexOf("normalizeFrames(", assignmentStart)
  const parenStart = source.indexOf("(", exprStart)
  const exprEnd = findMatchingParen(source, parenStart)
  const expression = source.slice(exprStart, exprEnd + 1)
  const companionHeadWide = sharedRows.menuHeadWide.map(staticRow)
  return Function(
    "companionHeadWide",
    "createCompanionFrame",
    "normalizeFrames",
    `return ${expression}`,
  )(companionHeadWide, createCompanionFrame, normalizeFrames) as string[][]
}

function parseCompanionActionFrames(source: string, sharedRows: { menuHeadWide: GoblinRow[] }) {
  const start = source.indexOf("const companionActionFrames")
  if (start === -1) return {} as Record<string, string[][]>
  const assignmentStart = source.indexOf("=", start)
  const objectStart = source.indexOf("{", assignmentStart)
  const objectEnd = findMatchingBrace(source, objectStart)
  const expression = source.slice(objectStart, objectEnd + 1)
  const companionHeadWide = sharedRows.menuHeadWide.map(staticRow)
  return Function(
    "companionHeadWide",
    "createCompanionFrame",
    "normalizeFrames",
    `return ${expression}`,
  )(companionHeadWide, createCompanionFrame, normalizeFrames) as Record<string, string[][]>
}

function parseCompanionActivityVariantCatalog(source: string, sharedRows: { menuHeadWide: GoblinRow[] }) {
  const start = source.indexOf("const companionActivityVariantCatalog")
  if (start === -1) return {} as Record<string, Record<string, CompanionActivityVariantDefinition>>
  const assignmentStart = source.indexOf("=", start)
  const objectStart = source.indexOf("{", assignmentStart)
  const objectEnd = findMatchingBrace(source, objectStart)
  const expression = source.slice(objectStart, objectEnd + 1)
  const companionHeadWide = sharedRows.menuHeadWide.map(staticRow)
  return Function(
    "companionHeadWide",
    "createCompanionFrame",
    "normalizeFrames",
    `return ${expression}`,
  )(companionHeadWide, createCompanionFrame, normalizeFrames) as Record<string, Record<string, CompanionActivityVariantDefinition>>
}

function normalizeFrame(frame: string[]) {
  const width = Math.max(0, ...frame.map((row) => row.length))
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

function renderCompanionAction(preview: CompanionActionPreview) {
  return `<section class="card ${preview.recommended ? "recommended" : ""}">
    <h2>${preview.id}. ${escapeHtml(preview.name)}</h2>
    <div class="companion-headline">${escapeHtml(preview.summary)}</div>
    <div class="verdict-row"><span class="verdict-badge ${preview.recommended ? "is-recommended" : ""}">${escapeHtml(preview.verdict)}</span></div>
    <p class="card-note">${escapeHtml(preview.note)}</p>
    <div class="frames">
      ${renderFrame(preview.idleFrames[0] ?? [], "idle")}
      ${preview.actionFrames.map((frame, index) => renderFrame(frame, `action f${index + 1}`)).join("")}
    </div>
  </section>`
}

function renderCompanionActivity(preview: CompanionActivityPreview) {
  return `<section class="card">
    <h2>${escapeHtml(preview.id)}. ${escapeHtml(preview.name)}</h2>
    <div class="companion-headline">${escapeHtml(preview.summary)}</div>
    <p class="card-note">${escapeHtml(preview.note)}</p>
    <div class="frames">${preview.frames.map((frame, index) => renderFrame(frame, `f${index + 1}`)).join("")}</div>
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

function renderNativeCompanionScene(options: {
  label: string
  detail: string
  frame: string[]
  title: string
  spend: string
  last: string
  status: string
  context: string
}) {
  return `<section class="card companion-scene">
    <h2>${escapeHtml(options.label)}</h2>
    <div class="companion-headline">${escapeHtml(options.detail)}</div>
    <div class="native-sidebar">
      <div class="native-sidebar-copy">
        <div class="native-sidebar-title">${escapeHtml(options.title)}</div>
        <div class="native-sidebar-row"><span>spend :</span><b>${escapeHtml(options.spend)}</b></div>
        <div class="native-sidebar-row"><span>last&nbsp;&nbsp;:</span><b>${escapeHtml(options.last)}</b></div>
        <div class="native-sidebar-status">${escapeHtml(options.status)}</div>
        <div class="native-sidebar-context">${escapeHtml(options.context)}</div>
      </div>
      <div class="native-sidebar-sprite">${renderSprite(options.frame, "native-sprite")}</div>
    </div>
  </section>`
}

const source = await Bun.file(sidebarPath).text()
const sidebarCols = parseSidebarWidth(source)
const variants = parseVariants(source)
if (variants.length === 0) throw new Error("No chat goblin variants found")

const companionSharedRows = {
  menuHeadWide: parseSharedRows(source, "menuHeadWide"),
}
const companionIdleFrames = parseCompanionIdleFrames(source, companionSharedRows)
const companionActionFrames = parseCompanionActionFrames(source, companionSharedRows)
const companionActivityVariantCatalog = parseCompanionActivityVariantCatalog(source, companionSharedRows)
const focusBodyVariants = ["40", "30", "39"]
  .map((id) => variants.find((variant) => variant.id === id))
  .filter(Boolean) as ChatGoblinVariant[]
const companionPreviews: CompanionActionPreview[] = [
  {
    id: "01",
    name: "pocket add",
    summary: "Base sprite 40 with a dedicated companion-only pocket-add motion.",
    verdict: "placeholder / acceptable",
    note:
      "Not the current favorite, but usable as a temporary spend action. Production behavior should trigger only on real spend deltas, not on the dev preview loop.",
    idleFrames: companionIdleFrames,
    actionFrames: companionActionFrames["01"] ?? companionIdleFrames,
  },
  {
    id: "02",
    name: "stamp spend",
    summary: "Dedicated stamp/receipt idea, but the read is still awkward and needs redesign.",
    verdict: "needs redesign",
    note:
      "User feedback: animation 02 looks super weird right now. Keep it in preview coverage so future iterations can compare against it, but do not treat it as the target motion.",
    idleFrames: companionIdleFrames,
    actionFrames: companionActionFrames["02"] ?? companionIdleFrames,
  },
  {
    id: "03",
    name: "coin toss",
    summary: "Best current companion action. This is the strongest reference for future activity work.",
    verdict: "current best / reference",
    recommended: true,
    note:
      "For now, the preferred direction is sprite 40 with animation 03. If another agent needs a working baseline, this is the visual reference to follow while better activity-specific motions are designed.",
    idleFrames: companionIdleFrames,
    actionFrames: companionActionFrames["03"] ?? companionIdleFrames,
  },
  {
    id: "04",
    name: "total replace",
    summary: "Dedicated total-replace idea, but it currently reads weird and needs redesign.",
    verdict: "needs redesign",
    note:
      "User feedback: animation 04 looks super weird right now. Keep it visible in the review so redesign work stays grounded in the current attempt rather than reinventing it blind.",
    idleFrames: companionIdleFrames,
    actionFrames: companionActionFrames["04"] ?? companionIdleFrames,
  },
]
const companionActivityNotes = {
  thinking:
    "Thinking candidates should only run during real pending/thinking state — not as a permanent background loop outside that state.",
  image:
    "Image candidates should only run during real image-generation progress. They should not replace the short spend burst.",
  audio:
    "Audio candidates should only run during real audio-generation progress. They should stay event-driven by runtime state, not by the dev preview loop alone.",
} as const
const companionActivityLabels = {
  thinking: "thinking",
  image: "image generation",
  audio: "audio generation",
} as const
const companionActivityPreviews: CompanionActivityPreview[] = Object.entries(companionActivityVariantCatalog).flatMap(
  ([kind, variants]) =>
    Object.entries(variants).map(([variantId, preview]) => ({
      id: `${companionActivityLabels[kind as keyof typeof companionActivityLabels]} ${variantId}`,
      name: preview.name,
      summary: preview.summary,
      note: companionActivityNotes[kind as keyof typeof companionActivityNotes],
      frames: preview.frames,
    })),
)
const finalRuntimeCompanionScenes = [
  renderNativeCompanionScene({
    label: "Final runtime · idle",
    detail: "Header variant 09 stays the default home art; the sidebar companion rests as sprite 40 with the corrected menuHeadWide shape.",
    frame: companionIdleFrames[0] ?? [],
    title: "CodeGoblin companion",
    spend: "$0.00",
    last: "waiting",
    status: "ready with pockets empty",
    context: "idle until a real runtime signal arrives",
  }),
  renderNativeCompanionScene({
    label: "Final runtime · spend delta",
    detail: "Animation 03 is the real spend burst and only starts when session cost increases.",
    frame: companionActionFrames["03"]?.[1] ?? companionIdleFrames[0] ?? [],
    title: "CodeGoblin adds spend",
    spend: "$0.39",
    last: "+$0.39",
    status: "tosses +$0.39 into the spend pile",
    context: "trigger: actual session cost delta",
  }),
  renderNativeCompanionScene({
    label: "Final runtime · token delta",
    detail: "Free/local models still get the same chosen burn animation when tokens increase but spend stays flat.",
    frame: companionActionFrames["03"]?.[2] ?? companionIdleFrames[0] ?? [],
    title: "CodeGoblin burns tokens",
    spend: "$0.00",
    last: "+1,248 tokens",
    status: "tosses +1,248 tokens into the token burn pile",
    context: "trigger: actual session token delta",
  }),
  renderNativeCompanionScene({
    label: "Final runtime · pending reply",
    detail: "Thinking animation is tied to a real incomplete assistant message, not a background loop.",
    frame: companionActivityVariantCatalog.thinking?.["01"]?.frames[1] ?? companionIdleFrames[0] ?? [],
    title: "CodeGoblin is thinking",
    spend: "$0.39",
    last: "+$0.39",
    status: "thinking through the reply",
    context: "trigger: pending assistant reply",
  }),
  renderNativeCompanionScene({
    label: "Final runtime · image progress",
    detail: "Image animation is tied to live codegoblin image-progress metadata.",
    frame: companionActivityVariantCatalog.image?.["01"]?.frames[1] ?? companionIdleFrames[0] ?? [],
    title: "CodeGoblin paints pixels",
    spend: "$0.39",
    last: "+$0.39",
    status: "painting an image",
    context: "trigger: image-progress message part",
  }),
  renderNativeCompanionScene({
    label: "Final runtime · audio progress",
    detail: "Audio animation is tied to live codegoblin audio-progress metadata.",
    frame: companionActivityVariantCatalog.audio?.["01"]?.frames[1] ?? companionIdleFrames[0] ?? [],
    title: "CodeGoblin mixes audio",
    spend: "$0.39",
    last: "+$0.39",
    status: "mixing audio",
    context: "trigger: audio-progress message part",
  }),
]

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeGoblin goblin review</title>
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
      .card.recommended {
        border-color: #3a7f2f;
        box-shadow: 0 0 0 1px rgba(154, 219, 53, 0.22), 0 10px 35px rgba(0, 0, 0, 0.24);
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
      .verdict-row {
        margin-top: 8px;
      }
      .verdict-badge {
        display: inline-flex;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        border: 1px solid #24432a;
        color: #d6f5d2;
        background: #0b1b10;
      }
      .verdict-badge.is-recommended {
        color: #0f2a10;
        background: var(--skin);
        border-color: #72a321;
        font-weight: 700;
      }
      .card-note {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        margin: 10px 0 0;
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
      <h1>CodeGoblin goblin review</h1>
      <p>Focused CodeGoblin review. Chat body comparisons and companion actions below are rendered from the exact sidebar sprite data so the browser preview stays honest with the CLI.</p>
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
          <h2 class="section-title">Final runtime behavior</h2>
          <p class="section-copy">Chosen behavior: home header variant 09, sidebar sprite 40/menuHeadWide shape, companion mode by default, animation 03 for real spend/token-burn deltas, and no production preview loop. The scenes below are rendered from the same frame data the CLI uses.</p>
          <div class="grid companion-samples">${finalRuntimeCompanionScenes.join("")}</div>
      <h2 class="section-title">Focused frame cycles</h2>
      <p class="section-copy">Only the exact body variants in play right now: 40, 30, and 39.</p>
      <div class="grid">${focusBodyVariants.map(renderVariant).join("")}</div>
      <h2 class="section-title">Companion action review</h2>
          <p class="section-copy">Chosen runtime: keep sprite 40 as the companion base and use animation 03 as the real spend/token-burn burst. Animations 02 and 04 are still weird and need redesign. Preview loops here are dev-only; production behavior triggers action animation only on actual cost/token deltas.</p>
      <div class="grid">${companionPreviews.map(renderCompanionAction).join("")}</div>
      <h2 class="section-title">Companion activity review</h2>
      <p class="section-copy">These are the ongoing activity candidate grids for non-spend work. They are intended for real runtime states like thinking, image progress, and audio progress — not as a replacement for the short spend-burst animation. None of these are final; this section exists so we can compare a bunch of options before promoting one into the main runtime path.</p>
      <div class="grid">${companionActivityPreviews.map(renderCompanionActivity).join("")}</div>
    </main>
  </body>
</html>`

await mkdir(outputDir, { recursive: true })
await writeFile(outputPath, html)

console.log(`Wrote ${outputPath}`)
console.log(pathToFileURL(outputPath).href)