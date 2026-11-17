/**
 * What `codegoblin ...` was asked to do, from its arguments alone.
 *
 * Pure, so the rules are tested without starting anything. The terminal app, the web server and the one-shot
 * prompt each read `process.argv` as they load, so the entry point works out which one is meant, takes its own
 * word off the front and loads only that one.
 */
export type Route =
  | { kind: "tui"; args: string[] }
  | { kind: "web"; args: string[] }
  | { kind: "run"; args: string[] }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "upgrade"; args: string[] }
  /** An option nobody knows. Said, rather than ignored: `--modle zai` used to open the app on the default model with no word about it. */
  | { kind: "unknown"; option: string }
  /** The app starting a helper copy of itself; never typed by a person. */
  | { kind: "worker"; name: "voice" | "cursor" | "reaper" }

export const WORKER_FLAGS = { voice: "__voice-worker", cursor: "__cursor-worker", reaper: "__reaper" } as const

export function route(argv: string[]): Route {
  const [first, ...rest] = argv
  if (first === WORKER_FLAGS.voice) return { kind: "worker", name: "voice" }
  if (first === WORKER_FLAGS.cursor) return { kind: "worker", name: "cursor" }
  if (first === WORKER_FLAGS.reaper) return { kind: "worker", name: "reaper" }
  if (first === "--version" || first === "-v" || first === "version") return { kind: "version" }
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" }
  if (first === "web") return { kind: "web", args: rest }
  if (first === "run") return { kind: "run", args: rest }
  if (first === "upgrade" || first === "update") return { kind: "upgrade", args: rest }
  // Anything else belongs to the terminal app: a folder to open, --model, or nothing at all. A folder that
  // happens to be called "web" or "run" is opened as ./web.
  const unknown = argv.find((entry) => entry.startsWith("-") && entry !== "--model" && entry !== "--provider")
  if (unknown) return { kind: "unknown", option: unknown }
  return { kind: "tui", args: argv }
}

export function helpText(command: string, version: string): string {
  return [
    `CodeGoblin ${version}`,
    "",
    "Usage:",
    `  ${command}                        open the terminal app in this folder`,
    `  ${command} <folder>               open it in another folder`,
    `  ${command} --model <provider/model>   start on a particular model`,
    `  ${command} web                    start the web app (http://localhost:4400)`,
    `  ${command} run "<prompt>"         send one prompt and print the answer (--model works here too)`,
    `  ${command} upgrade                update to the newest version`,
    `  ${command} --version              print the version`,
    "",
    "Inside the app, / lists every command and /help explains them.",
  ].join("\n")
}
