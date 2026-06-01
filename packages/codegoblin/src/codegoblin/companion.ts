export type CodeGoblinCompanionMode = "pinned" | "companion"
export type CodeGoblinCompanionActivityKind = "idle" | "thinking" | "image" | "audio"
export type CodeGoblinCompanionBurn =
  | {
      kind: "spend"
      amount: number
    }
  | {
      kind: "tokens"
      amount: number
    }

const COST_DELTA_EPSILON = 0.0000001

export function codeGoblinFlagEnabled(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

export function codeGoblinCompanionVisible(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off" || normalized === "hidden") {
    return false
  }
  return true
}

export function codeGoblinCompanionMode(value: string | undefined): CodeGoblinCompanionMode {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "pinned") return "pinned"
  return "companion"
}

export function codeGoblinCompanionActionVariant(value: string | undefined) {
  const cleaned = value?.trim().replace(/^v/i, "")
  const numeric = Number(cleaned)
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 4) return String(numeric).padStart(2, "0")
  return "03"
}

export function codeGoblinCompanionActivityVariant(value: string | undefined) {
  const cleaned = value?.trim().replace(/^v/i, "")
  const numeric = Number(cleaned)
  if (numeric === 2) return "02"
  if (numeric === 3) return "03"
  return "01"
}

export function codeGoblinCompanionActivity(value: string | undefined): CodeGoblinCompanionActivityKind {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "thinking") return "thinking"
  if (normalized === "image" || normalized === "image-progress") return "image"
  if (normalized === "audio" || normalized === "audio-progress") return "audio"
  return "idle"
}

export function codeGoblinCompanionBurnDelta(input: {
  previousCost: number | undefined
  currentCost: number
  previousTokens: number | undefined
  currentTokens: number
}): CodeGoblinCompanionBurn | undefined {
  if (input.previousCost === undefined || input.previousTokens === undefined) return undefined

  const costDelta = Math.max(0, input.currentCost) - Math.max(0, input.previousCost)
  if (costDelta > COST_DELTA_EPSILON) {
    return {
      kind: "spend",
      amount: costDelta,
    }
  }

  const tokenDelta = Math.max(0, Math.trunc(input.currentTokens)) - Math.max(0, Math.trunc(input.previousTokens))
  if (tokenDelta > 0) {
    return {
      kind: "tokens",
      amount: tokenDelta,
    }
  }

  return undefined
}
