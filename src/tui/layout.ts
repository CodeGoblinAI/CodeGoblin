import { displayWidth, truncateMiddle, truncateToWidth } from "./width"

/** Rows actually drawn below the transcript, including the toolbar. */
export function footerHeight(parts: {
  prompt: number
  palette?: number
  plan?: number
  overlay?: number
  pending?: number
  queued?: boolean
  images?: boolean
  scrolled?: boolean
  /** Rows above the composer's top rule: the working line, and a status message. */
  notice?: number
}) {
  return 4 + parts.prompt + (parts.notice ?? 0) + (parts.palette ?? 0) + (parts.plan ?? 0) +
    (parts.overlay ?? 0) + (parts.pending ?? 0) +
    Number(Boolean(parts.queued)) + Number(Boolean(parts.images)) + Number(Boolean(parts.scrolled))
}

export type StatusBarInput = {
  cols: number
  modeLabel: string
  providerLabel: string
  modelLabel: string
  contextText: string
  spendText: string
  tags?: { full: string; short: string }[]
  rightFull: string
  rightCompact: string
}

/**
 * Lays out the bottom status bar so numbers (cost cents and context %) are never clipped
 * or overlapped by the model name or key hints at any terminal width.
 */
export function formatStatusBar(input: StatusBarInput): { mode: string; plain: string; gap: number; right: string } {
  const cols = Math.max(12, input.cols)
  const mode =
    cols < 54 && input.modeLabel === "approve for me"
      ? "approve"
      : cols < 46 && input.modeLabel === "full access"
        ? "full"
        : input.modeLabel
  const ctx =
    cols < 54
      ? input.contextText.replace("ctx window unknown", "ctx ?").replace(" ctx", "")
      : input.contextText
  const sacred = [ctx, input.spendText].filter(Boolean).join("  ")
  const tags = input.tags ?? []
  const fullTags = tags.map((tag) => tag.full).join("  ")
  const shortTags = tags.map((tag) => tag.short).join("  ")
  const fullName = [input.providerLabel, input.modelLabel].filter(Boolean).join(" ")
  const idealLeft = [fullName, sacred, fullTags].filter(Boolean).join("  ")

  const leadWidth = 5 + displayWidth(mode) // "  " + mode + " · "
  const fitsWith = (left: string, right: string) =>
    leadWidth + displayWidth(left) + (right ? 1 + displayWidth(right) : 0) + 2 <= cols

  const right =
    cols >= 75 && fitsWith(idealLeft, input.rightFull)
      ? input.rightFull
      : fitsWith(sacred, input.rightCompact)
        ? input.rightCompact
        : ""

  const rightReserve = right ? displayWidth(right) + 3 : 2
  const budget = Math.max(0, cols - leadWidth - rightReserve)

  const buildWithTail = (tail: string, minName: number): string | undefined => {
    if (displayWidth(tail) > budget) return undefined
    const nameRoom = tail ? budget - displayWidth(tail) - 2 : budget
    if (displayWidth(fullName) <= nameRoom) return [fullName, tail].filter(Boolean).join("  ")
    if (displayWidth(input.modelLabel) <= nameRoom) return [input.modelLabel, tail].filter(Boolean).join("  ")
    if (nameRoom >= minName) return [truncateMiddle(input.modelLabel, nameRoom), tail].filter(Boolean).join("  ")
    return undefined
  }

  const tailFull = [sacred, fullTags].filter(Boolean).join("  ")
  const tailShort = [sacred, shortTags].filter(Boolean).join("  ")
  let plain = buildWithTail(tailFull, 10) ?? buildWithTail(tailShort, 8)

  if (plain === undefined) {
    // Shed tags from right to left before ever cutting spend or context digits.
    const kept = tags.map((tag) => tag.short)
    while (kept.length && displayWidth([sacred, ...kept].filter(Boolean).join("  ")) > budget) kept.pop()
    const tail = [sacred, ...kept].filter(Boolean).join("  ")
    plain = buildWithTail(tail, 6) ?? (displayWidth(tail) <= budget ? tail : undefined)
  }

  if (plain === undefined) {
    // Sliver window (<25 cols): keep cost whole first, then whatever fits.
    plain = input.spendText && displayWidth(input.spendText) <= budget
      ? input.spendText
      : truncateToWidth(sacred || input.modelLabel, budget)
  }

  const usedLeft = plain ? leadWidth + displayWidth(plain) : 2 + displayWidth(mode)
  const gap = right ? Math.max(1, cols - 2 - usedLeft - displayWidth(right)) : 0
  return { mode, plain, gap, right }
}
