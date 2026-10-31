import os from "node:os"
import path from "node:path"
import { effortLevels, type Provider } from "./providers"

/**
 * The environment the model is working in, stated every turn: which app,
 * model, effort level, permission mode and folder, the platform and the date.
 *
 * Codex and Gemini CLI both give the model its environment up front rather than
 * leaving it to find out. Without it, a real "what effort are you on?" became
 * an 84-step search of the machine. The block only states facts; how to use
 * them is in the system prompt, in general terms.
 */
export type SessionFactsInput = {
  provider: Provider
  modelId: string
  /** The level sent to the model, or undefined when none is - "auto". */
  effort?: string
  mode?: string
  root: string
  home?: string
  platform?: string
  now?: Date
}

const MODE_WORDS: Record<string, string> = {
  ask: "ask - the user approves changes, commands and internet use",
  approve: "approve for me - edits and read-only commands run; anything riskier asks",
  full: "full access - nothing asks except the rules, checkpoints and secret files",
}

export function sessionFacts(input: SessionFactsInput): string {
  const model = input.provider.models.find((entry) => entry.id === input.modelId)
  const label = model ? `${input.provider.label} ${model.label}` : input.provider.label
  const levels = model ? effortLevels(model) : []
  const effort = !levels.length
    ? "this model has no effort setting"
    : input.effort
      ? `${input.effort} (this model's levels: ${levels.join(", ")})`
      : `auto - no level is sent, so the model's own default applies${model?.defaultEffort ? ` (${model.defaultEffort})` : ""}; levels: ${levels.join(", ")}`
  const home = input.home ?? os.homedir()
  const atHome = Boolean(input.root) && path.resolve(input.root).toLowerCase() === path.resolve(home).toLowerCase()
  const platform = input.platform ?? process.platform
  const now = input.now ?? new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  return [
    "Environment (current, and kept up to date by the app):",
    "- App: CG-Next, CodeGoblin rebuilt from scratch",
    `- Model: ${label} (${input.provider.id}/${input.modelId})`,
    `- Reasoning effort: ${effort}. The user changes it with /effort.`,
    ...(input.mode ? [`- Permission mode: ${MODE_WORDS[input.mode] ?? input.mode}`] : []),
    `- Working directory: ${input.root}${atHome ? " (the user's home folder, not a project)" : ""}`,
    `- Platform: ${platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform}`,
    `- Today: ${day}`,
  ].join(String.fromCharCode(10))
}
