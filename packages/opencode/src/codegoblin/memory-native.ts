import path from "path"
import { fileURLToPath } from "url"
import { scanMemoryContent } from "./memory-guard"

// CodeGoblin native efficiency layer adapter.
//
// When the `codegoblin-native` binary is available it is used for ranked recall
// scoring and guard scanning; otherwise an equivalent pure-TS implementation is
// used. Behavior is identical either way — the native path is purely a speed
// optimization for large memory sets, kept behind this contract + fallback so a
// missing or unbuilt binary never dead-ends the feature.

export type RankEntryInput = {
  id: string
  content: string
  pinned?: boolean
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "are", "was", "but", "not", "all",
  "any", "can", "has", "have", "from", "into", "out", "use", "using", "when", "what", "how",
])

export function extractTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2 && !STOPWORDS.has(term))
}

function scoreEntryTs(queryTerms: string[], entry: RankEntryInput): number {
  if (queryTerms.length === 0) return entry.pinned ? 2 : 0
  const contentTerms = extractTerms(entry.content)
  let score = 0
  for (const term of queryTerms) score += contentTerms.filter((t) => t === term).length
  if (entry.pinned) score += 2
  return score
}

function rankEntriesTs(query: string, entries: readonly RankEntryInput[]): { id: string; score: number }[] {
  const queryTerms = extractTerms(query)
  return entries
    .map((entry, index) => ({ index, id: entry.id, score: scoreEntryTs(queryTerms, entry) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ id, score }) => ({ id, score }))
}

function scanContentBatchTs(contents: readonly string[]): (string | undefined)[] {
  return contents.map((content) => scanMemoryContent(content))
}

let nativeBinChecked = false
let nativeBin: string | undefined

function resolveNativeBin(): string | undefined {
  if (nativeBinChecked) return nativeBin
  nativeBinChecked = true
  const configured = process.env["CODEGOBLIN_NATIVE_BIN"]?.trim()
  const exe = process.platform === "win32" ? ".exe" : ""
  const here = path.dirname(fileURLToPath(import.meta.url))
  // packages/opencode/src/codegoblin -> packages/opencode-native/target/release
  const fallback = path.resolve(here, "../../../opencode-native/target/release", `codegoblin-native${exe}`)
  for (const candidate of [configured, fallback]) {
    if (candidate && Bun.file(candidate).size > 0) {
      nativeBin = candidate
      return nativeBin
    }
  }
  nativeBin = undefined
  return nativeBin
}

export function isNativeAvailable(): boolean {
  return resolveNativeBin() !== undefined
}

async function runNative(request: unknown): Promise<any | undefined> {
  const bin = resolveNativeBin()
  if (!bin) return undefined
  try {
    const proc = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    proc.stdin.write(JSON.stringify(request))
    await proc.stdin.end()
    const output = await new Response(proc.stdout).text()
    await proc.exited
    const parsed = JSON.parse(output.trim())
    if (parsed && parsed.ok) return parsed
    return undefined
  } catch {
    return undefined
  }
}

export async function rankEntries(
  query: string,
  entries: readonly RankEntryInput[],
): Promise<{ id: string; score: number }[]> {
  if (entries.length === 0) return []
  const native = await runNative({
    op: "rank",
    query,
    entries: entries.map((entry) => ({ id: entry.id, content: entry.content, pinned: Boolean(entry.pinned) })),
  })
  if (native?.ranked) return native.ranked as { id: string; score: number }[]
  return rankEntriesTs(query, entries)
}

export async function scanContentBatch(contents: readonly string[]): Promise<(string | undefined)[]> {
  if (contents.length === 0) return []
  const native = await runNative({ op: "scan", contents: [...contents] })
  if (native?.reasons) return (native.reasons as (string | null)[]).map((reason) => reason ?? undefined)
  return scanContentBatchTs(contents)
}
