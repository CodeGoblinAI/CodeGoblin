import os from "node:os"
import path from "node:path"
import { effortLevels, type Provider } from "./providers"

/**
 * What the model is told about itself and this session, every turn.
 *
 * Asked "what effort are you running at?", a real DeepSeek run had no way to
 * know: nothing it was given said which app it was in, which model it was or
 * what was set. So it went looking - the fork's `codegoblin` command on PATH,
 * its config, its SQLite databases, its logs, the process tree, open ports,
 * auth.json - for 84 steps and a dollar before it was stopped. Every one of
 * those facts was sitting in the app that sent the question.
 */
export type SessionFactsInput = {
  provider: Provider
  modelId: string
  /** The level sent to the model, or undefined when none is - "auto". */
  effort?: string
  mode?: string
  root: string
  home?: string
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
  return [
    "About this session - answer questions about yourself and these settings from this list, without searching:",
    "- App: CG-Next, CodeGoblin rebuilt from scratch. A `codegoblin`, `cg` or `opencode` command on this machine is a different, older app; its config, logs and databases say nothing about this session.",
    `- Model: ${label} (${input.provider.id}/${input.modelId})`,
    `- Reasoning effort: ${effort}. The user changes it with /effort.`,
    ...(input.mode ? [`- Permission mode: ${input.mode}`] : []),
    `- Working directory: ${input.root}` +
      (atHome ? " - the user's home folder, not a project. Searching it walks everything they own, which is slow and costly; search a named folder instead." : ""),
    "Anything about the session not listed here, say you do not know and name the command that shows it (/status) rather than going to look.",
  ].join("\n")
}
