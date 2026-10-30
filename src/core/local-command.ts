import { contextFor, findEngine, installedModels, localRuntime, logPath, modelDirs, ownedEngineDir, readPrefs, savePrefs, toolsFor, type LocalRuntime } from "./local-runtime"

/**
 * /local - what CG-Next's own llama.cpp runtime is doing, and the few things
 * worth changing about it.
 *
 * One function for both surfaces, so the terminal and the browser say the
 * same thing about the same server.
 */

const NEWLINE = String.fromCharCode(10)
const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1) + " GB"
const count = (value: number) => value.toLocaleString("en-US")
const minutes = (ms: number) => ms < 60_000 ? Math.max(1, Math.round(ms / 1000)) + " s" : Math.round(ms / 60_000) + " min"

export const LOCAL_USAGE = "usage: /local, /local stop, /local tools on|off|auto [model], /local context <tokens>|auto [model]"

export async function localCommand(argument: string, current?: string, runtime: LocalRuntime = localRuntime): Promise<string> {
  const [action = "", value, named] = argument.trim().split(/\s+/).filter(Boolean)
  const currentId = current?.startsWith("llama/") ? current.slice("llama/".length) : undefined
  const target = () => {
    const id = named ?? currentId
    if (!id) return { error: "Name a local model, or pick one under Local first: " + LOCAL_USAGE }
    const file = installedModels({ fresh: true }).find((model) => model.id === id)
    return file ? { file } : { error: `${id} is not an installed local model; /local lists them.` }
  }

  switch (action) {
    case "":
    case "status":
      return localStatus(runtime)
    case "stop": {
      const status = runtime.status()
      if (status.state === "stopped") return "No local model server is running."
      if (status.busy > 0) return `${status.model} is answering right now. Stop that answer first, then /local stop.`
      await runtime.stop()
      return `Stopped llama-server (${status.model}); its memory is free again. It starts on the next prompt to a Local model.`
    }
    case "tools": {
      if (value !== "on" && value !== "off" && value !== "auto") return LOCAL_USAGE
      const found = target()
      if ("error" in found) return found.error!
      savePrefs(found.file.id, { tools: value === "auto" ? undefined : value === "on" })
      const now = toolsFor(found.file)
      return `${found.file.id}: ${now.on ? "offered CG's tools" : "chat only, no tools"}` +
        (now.chosen ? " (your choice; /local tools auto decides by size again)." : ` (decided by size: ${gb(found.file.sizeBytes)}).`) +
        (now.on && found.file.sizeBytes < 4 * 1024 ** 3 ? " Small models often call the wrong tool or loop; approvals still apply." : "") +
        " Applies from the next prompt."
    }
    case "context": {
      const tokens = value === "auto" ? undefined : Number(value)
      if (value !== "auto" && !(Number.isInteger(tokens) && tokens! >= 2048 && tokens! <= 262_144)) return "Context is a whole number of tokens from 2048 to 262144, or auto."
      const found = target()
      if ("error" in found) return found.error!
      savePrefs(found.file.id, { context: tokens })
      const status = runtime.status()
      // A context size is fixed when the server starts, so a running server is
      // restarted for it - unless it is mid-answer, which is never interrupted.
      let restart = " Applies the next time it starts."
      if (status.state !== "stopped" && status.model === found.file.id) {
        if (status.busy > 0) restart = " Applies once the current answer finishes and the server restarts (/local stop)."
        else { await runtime.stop(); restart = " The server was stopped and restarts with it on the next prompt." }
      }
      return `${found.file.id}: ${count(contextFor(found.file))} tokens of context${value === "auto" ? " (default)" : ""}.${restart} More context needs more memory.`
    }
    default:
      return LOCAL_USAGE
  }
}

/**
 * Short lines joined by middots rather than padded columns: the terminal
 * wraps a long line and the browser draws this in a proportional font, and
 * columns survive neither.
 */
export function localStatus(runtime: LocalRuntime = localRuntime): string {
  const lines: string[] = ["Local models: llama.cpp, run by CG-Next on this machine"]
  const engine = findEngine()
  if (engine) {
    const whose = engine.source === "shared" ? "the CodeGoblin fork's, used read-only" : engine.source === "configured" ? "set by CODEGOBLIN_LOCAL_ENGINE" : "CG-Next's own"
    lines.push(`Engine: ${whose} · ${engine.gpu ? "CUDA, layers on the GPU" : "CPU only"}`, "  " + engine.path)
  } else lines.push("Engine: none found. Put llama.cpp's llama-server in", "  " + ownedEngineDir(), "  or set CODEGOBLIN_LOCAL_ENGINE.")

  const status = runtime.status()
  if (status.state === "stopped") {
    lines.push("Server: stopped. It starts on a prompt to a Local model and stops when CG-Next exits.")
    if (status.lastError) lines.push("Last error: " + status.lastError.split(NEWLINE)[0], ...status.lastError.split(NEWLINE).slice(1).map((line) => "  " + line))
  } else {
    lines.push(`Server: ${status.state === "loading" ? "loading" : "serving"} ${status.model} · ${count(status.context)} context · up ${minutes(Date.now() - status.since)}` +
      (status.busy ? ` · ${status.busy} answer${status.busy === 1 ? "" : "s"} running` : ""))
    lines.push(`  127.0.0.1:${status.port} · pid ${status.pid} · owned by this CG-Next; /local stop frees its memory`, "  log " + logPath())
  }
  if (status.reclaimed.length) lines.push("Cleaned up servers an earlier CG-Next run left behind: " + status.reclaimed.join(", "))

  const prefs = readPrefs()
  const models = installedModels({ fresh: true })
  lines.push("")
  if (!models.length) lines.push("No GGUF models installed yet.")
  else {
    lines.push("Installed (/model llama/<id>, or Local models in the picker):")
    for (const model of models) {
      const tools = toolsFor(model, prefs)
      lines.push(`  ${model.id} · ${gb(model.sizeBytes)} · ${tools.on ? "tools" : "chat only"}${tools.chosen ? " (your choice)" : ""} · ${count(contextFor(model, prefs))} ctx · ${model.source === "shared" ? "shared" : "CG-Next's"}`)
    }
  }
  lines.push("Looked in:", ...modelDirs().map((entry) => "  " + entry.dir + (entry.source === "owned" ? " (CG-Next's own)" : "")))
  lines.push("", "/local stop · /local tools on|off|auto [model] · /local context <tokens>|auto [model]")
  return lines.join(NEWLINE)
}
