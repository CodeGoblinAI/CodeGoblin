import { Token } from "@/util/token"

/**
 * How often a piece of prompt content changes. This is the vocabulary the cache
 * breakpoint placement uses: a provider cache entry is only useful if every byte
 * before the breakpoint is identical to the previous request, so the prefix has
 * to be ordered static -> session -> turn and the breakpoint dropped at the last
 * non-`turn` boundary.
 *
 * - `static`  identical for the lifetime of the install (base prompt text)
 * - `session` identical for the lifetime of a session (cwd, platform, skills)
 * - `turn`    regenerated every request (query-ranked memory, wall-clock date)
 */
export type Stability = "static" | "session" | "turn"

export const STABILITY_ORDER: Record<Stability, number> = {
  static: 0,
  session: 1,
  turn: 2,
}

export interface SystemBlock {
  readonly label: string
  readonly text: string
  readonly stability: Stability
}

export interface BlockReport {
  readonly label: string
  readonly stability: Stability
  readonly tokens: number
}

export interface ToolReport {
  readonly name: string
  readonly tokens: number
}

export interface ContextReport {
  /** Per-system-block token estimates, in prompt order. */
  readonly blocks: BlockReport[]
  /** Per-tool schema token estimates, largest first. */
  readonly tools: ToolReport[]
  readonly totals: {
    readonly system: number
    readonly tools: number
    /** Everything sent before the conversation itself. */
    readonly baseline: number
  }
  /**
   * Tokens sitting in the prefix that are safe to cache, i.e. everything up to
   * the first `turn`-stability block.
   */
  readonly cacheable: number
  /**
   * Tokens that cannot be cached because a `turn`-stability block appears
   * earlier in the prefix and poisons everything after it. This is the number
   * Phase 1 is trying to drive to zero.
   */
  readonly poisoned: number
  /** True when blocks are ordered static -> session -> turn. */
  readonly ordered: boolean
  /**
   * Index of the last block that may be followed by a cache breakpoint, or -1
   * when the very first block is already turn-volatile.
   */
  readonly breakpoint: number
}

function toolTokens(tool: unknown): number {
  if (!tool || typeof tool !== "object") return 0
  const record = tool as Record<string, unknown>
  let text = typeof record["description"] === "string" ? record["description"] : ""
  // The schema key varies across AI SDK versions and our own wrappers, so total
  // whichever ones are present rather than guessing a single shape.
  for (const key of ["inputSchema", "parameters", "schema"]) {
    const value = record[key]
    if (value === undefined) continue
    try {
      text += JSON.stringify(value)
    } catch {
      // Circular or non-serialisable schemas contribute nothing rather than throwing.
    }
  }
  return Token.estimate(text)
}

/**
 * Measures what a single request actually costs before any conversation content,
 * and how much of that cost the provider cache can absorb.
 *
 * Pure and synchronous on purpose: it runs on the hot request path, so it must
 * never do IO, and it stays trivially unit-testable.
 */
export function buildContextReport(input: {
  system: SystemBlock[]
  tools?: Record<string, unknown>
}): ContextReport {
  const blocks = input.system.map((block) => ({
    label: block.label,
    stability: block.stability,
    tokens: Token.estimate(block.text),
  }))

  const tools = Object.entries(input.tools ?? {})
    .map(([name, tool]) => ({ name, tokens: toolTokens(tool) }))
    .sort((a, b) => b.tokens - a.tokens)

  const systemTotal = blocks.reduce((sum, block) => sum + block.tokens, 0)
  const toolsTotal = tools.reduce((sum, tool) => sum + tool.tokens, 0)

  const firstVolatile = blocks.findIndex((block) => block.stability === "turn")
  const cacheable =
    firstVolatile === -1 ? systemTotal : blocks.slice(0, firstVolatile).reduce((sum, b) => sum + b.tokens, 0)
  const poisoned = systemTotal - cacheable

  let ordered = true
  for (let i = 1; i < blocks.length; i++) {
    if (STABILITY_ORDER[blocks[i].stability] < STABILITY_ORDER[blocks[i - 1].stability]) {
      ordered = false
      break
    }
  }

  return {
    blocks,
    tools,
    totals: {
      system: systemTotal,
      tools: toolsTotal,
      baseline: systemTotal + toolsTotal,
    },
    cacheable,
    poisoned,
    ordered,
    breakpoint: firstVolatile === -1 ? blocks.length - 1 : firstVolatile - 1,
  }
}

/** Compact one-line form for the debug log. */
export function summarize(report: ContextReport) {
  return {
    baseline: report.totals.baseline,
    system: report.totals.system,
    tools: report.totals.tools,
    cacheable: report.cacheable,
    poisoned: report.poisoned,
    ordered: report.ordered,
  }
}

/** Human-readable table used by `script/benchmark-context.ts` and `--context-report`. */
export function format(report: ContextReport, options?: { tools?: number }): string {
  const lines: string[] = []
  const pad = (value: string, width: number) => value.padEnd(width)
  const num = (value: number) => value.toLocaleString("en-US").padStart(9)

  lines.push("system prompt blocks")
  lines.push("  " + pad("block", 34) + pad("stability", 11) + "    tokens")
  lines.push("  " + "-".repeat(58))
  for (const block of report.blocks) {
    lines.push("  " + pad(block.label, 34) + pad(block.stability, 11) + num(block.tokens))
  }
  lines.push("  " + pad("", 45) + num(report.totals.system))

  const limit = options?.tools ?? 12
  if (report.tools.length) {
    lines.push("")
    lines.push(`tool schemas (top ${Math.min(limit, report.tools.length)} of ${report.tools.length})`)
    lines.push("  " + "-".repeat(58))
    for (const tool of report.tools.slice(0, limit)) {
      lines.push("  " + pad(tool.name, 45) + num(tool.tokens))
    }
    lines.push("  " + pad("", 45) + num(report.totals.tools))
  }

  const pct = report.totals.system > 0 ? Math.round((report.poisoned / report.totals.system) * 100) : 0
  lines.push("")
  lines.push("cache")
  lines.push("  " + "-".repeat(58))
  lines.push("  " + pad("baseline (system + tools)", 45) + num(report.totals.baseline))
  lines.push("  " + pad("cacheable prefix", 45) + num(report.cacheable))
  lines.push("  " + pad(`poisoned by turn-volatile blocks (${pct}%)`, 45) + num(report.poisoned))
  lines.push("  " + pad("ordered static -> session -> turn", 45) + (report.ordered ? "       yes" : "        NO"))

  return lines.join("\n")
}

export * as ContextReport from "./context-report"
