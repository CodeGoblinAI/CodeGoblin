import type { CommandModule } from "yargs"
import fs from "fs/promises"
import path from "path"
import { Process } from "@/util/process"
import { which } from "@/util/which"
import { nativeBinPath } from "@/codegoblin/memory-native"
import {
  DEFAULT_RUNTIME_PORT,
  LOCAL_MODEL_CATALOG,
  catalogEntry,
  detectAccel,
  engineDir,
  enginePath,
  isEngineInstalled,
  listInstalledModels,
  modelPath,
  readRuntimeState,
  runtimeDir,
  selectEngineAssets,
  writeRuntimeState,
} from "@/codegoblin/local-runtime"

const LLAMA_LATEST = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
const LLAMA_DOWNLOAD = (tag: string) => `https://github.com/ggml-org/llama.cpp/releases/download/${tag}`

function hasNvidiaGpu(): boolean {
  return Boolean(which("nvidia-smi"))
}

function resolveNativeBin(): string | undefined {
  return process.env.CODEGOBLIN_NATIVE_BIN || nativeBinPath()
}

async function downloadFile(url: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "codegoblin-runtime" } })
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`)
  await Bun.write(dest, response)
}

async function unzipTo(zip: string, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  if (process.platform === "win32") {
    await Process.run([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`,
    ])
    return
  }
  const unzip = which("unzip")
  if (unzip) {
    await Process.run([unzip, "-o", zip, "-d", dir])
    return
  }
  await Process.run(["tar", "-xf", zip, "-C", dir])
}

async function runInstall(force: boolean): Promise<void> {
  if (!force && (await isEngineInstalled())) {
    console.log(`llama.cpp engine already installed: ${enginePath()}`)
    return
  }
  const accel = detectAccel(hasNvidiaGpu())
  console.log(`Resolving latest llama.cpp release (${accel})…`)
  const release = (await (await fetch(LLAMA_LATEST, { headers: { "user-agent": "codegoblin-runtime" } })).json()) as {
    tag_name?: string
    assets?: { name: string }[]
  }
  const tag = release.tag_name
  const names = (release.assets ?? []).map((a) => a.name)
  if (!tag || names.length === 0) throw new Error("Could not read llama.cpp release assets.")
  const { engine, cudart } = selectEngineAssets(names, process.platform, accel)
  if (!engine) throw new Error(`No llama.cpp engine asset for ${process.platform}/${accel}.`)

  const tmp = path.join(runtimeDir(), ".tmp")
  await fs.mkdir(tmp, { recursive: true })
  try {
    console.log(`Downloading ${engine}…`)
    const engineZip = path.join(tmp, engine)
    await downloadFile(`${LLAMA_DOWNLOAD(tag)}/${engine}`, engineZip)
    await unzipTo(engineZip, engineDir())
    if (cudart) {
      console.log(`Downloading CUDA runtime ${cudart}…`)
      const cudartZip = path.join(tmp, cudart)
      await downloadFile(`${LLAMA_DOWNLOAD(tag)}/${cudart}`, cudartZip)
      await unzipTo(cudartZip, engineDir())
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
  console.log(`Installed llama.cpp ${tag} → ${enginePath()}`)
}

async function runPull(id: string): Promise<void> {
  const entry = catalogEntry(id)
  if (!entry) {
    throw new Error(`Unknown model '${id}'. Run 'codegoblin runtime list' to see the catalog.`)
  }
  const dest = modelPath(entry.id)
  if (await fs.stat(dest).catch(() => undefined)) {
    console.log(`Already downloaded: ${dest}`)
    return
  }
  console.log(`Pulling ${entry.name} (~${entry.approxMB} MB)…`)
  await downloadFile(entry.url, dest)
  console.log(`Saved ${dest}`)
}

async function runList(): Promise<void> {
  const state = await readRuntimeState()
  const installed = await listInstalledModels()
  console.log(`Runtime dir: ${runtimeDir()}`)
  console.log(`Engine:      ${(await isEngineInstalled()) ? enginePath() : "not installed (run `codegoblin runtime install`)"}`)
  console.log("")
  console.log("Installed models:")
  if (installed.length === 0) console.log("  (none — run `codegoblin runtime pull <id>`)")
  for (const model of installed) {
    const marker = model.id === state.model ? "*" : " "
    console.log(`  ${marker} ${model.id}  (${(model.sizeBytes / 1e6).toFixed(0)} MB)`)
  }
  console.log("")
  console.log("Available to pull:")
  for (const entry of LOCAL_MODEL_CATALOG) {
    console.log(`    ${entry.id}  — ${entry.name} (~${entry.approxMB} MB)`)
  }
}

async function resolveInstalledModel(id: string): Promise<{ id: string; path: string } | undefined> {
  const installed = await listInstalledModels()
  return (
    installed.find((m) => m.id === id) ?? installed.find((m) => m.id.toLowerCase() === id.toLowerCase())
  )
}

async function runUse(id: string): Promise<void> {
  const match = await resolveInstalledModel(id)
  if (!match) throw new Error(`'${id}' is not installed. Run 'codegoblin runtime pull ${id}' or 'codegoblin runtime list'.`)
  const state = await readRuntimeState()
  await writeRuntimeState({ ...state, model: match.id })
  console.log(`Default local model set to ${match.id}`)
}

async function runStart(opts: { model?: string; port?: number; ngl?: number }): Promise<void> {
  if (!(await isEngineInstalled())) throw new Error("llama.cpp engine not installed. Run 'codegoblin runtime install' first.")
  const state = await readRuntimeState()
  const modelId = opts.model ?? state.model
  if (!modelId) throw new Error("No model selected. Run 'codegoblin runtime use <id>' or pass --model.")
  const match = await resolveInstalledModel(modelId)
  if (!match) throw new Error(`Model '${modelId}' is not installed.`)
  const native = resolveNativeBin()
  if (!native) throw new Error("codegoblin-native binary not found. Build it or set CODEGOBLIN_NATIVE_BIN.")
  const port = opts.port ?? state.port ?? DEFAULT_RUNTIME_PORT
  await writeRuntimeState({ model: match.id, port })
  console.log(`Starting CodeGoblin local runtime: ${match.id} on http://127.0.0.1:${port}/v1`)
  const proc = Process.spawn(
    [native, "llama", "--model", match.path, "--engine", enginePath(), "--port", String(port), "--ngl", String(opts.ngl ?? 99)],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  )
  await proc.exited
}

async function runStatus(): Promise<void> {
  const state = await readRuntimeState()
  const engine = await isEngineInstalled()
  const port = state.port ?? DEFAULT_RUNTIME_PORT
  let running = false
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    running = res.ok
  } catch {}
  console.log(`Engine installed: ${engine ? "yes" : "no"}`)
  console.log(`Selected model:   ${state.model ?? "(none)"}`)
  console.log(`Runtime running:  ${running ? `yes (127.0.0.1:${port})` : "no"}`)
}

type Args = { force?: boolean; id?: string; model?: string; port?: number; ngl?: number }

export const RuntimeCommand = {
  command: "runtime <command>",
  describe: "manage the CodeGoblin first-party local model runtime (llama.cpp)",
  builder: (yargs) =>
    yargs
      .command(
        "install",
        "download the bundled llama.cpp engine for this machine",
        (y) => y.option("force", { type: "boolean", default: false, describe: "reinstall even if present" }),
        async (args) => runInstall(Boolean(args.force)),
      )
      .command(
        "pull <id>",
        "download a local GGUF model from the catalog",
        (y) => y.positional("id", { type: "string", demandOption: true }),
        async (args) => runPull(String(args.id)),
      )
      .command("list", "list installed + available local models", {}, async () => runList())
      .command(
        "use <id>",
        "set the default local model",
        (y) => y.positional("id", { type: "string", demandOption: true }),
        async (args) => runUse(String(args.id)),
      )
      .command(
        "start",
        "start the local runtime server (llama.cpp on :8787)",
        (y) =>
          y
            .option("model", { type: "string", describe: "model id (defaults to selected)" })
            .option("port", { type: "number", default: DEFAULT_RUNTIME_PORT })
            .option("ngl", { type: "number", default: 99, describe: "GPU layers to offload" }),
        async (args) => runStart({ model: args.model, port: args.port, ngl: args.ngl }),
      )
      .command("status", "show local runtime status", {}, async () => runStatus())
      .demandCommand(1),
  handler: () => {},
} satisfies CommandModule<object, Args>
