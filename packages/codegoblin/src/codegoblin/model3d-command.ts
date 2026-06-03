import fs from "fs/promises"
import os from "os"
import path from "path"
import { getModel3DProvider, type Model3DInputImage, type Model3DInputMode } from "./model3d-providers"

export type Model3DCommandResult = {
  ok: boolean
  message: string
  output?: string
  model?: string
  provider?: string
  modelVersion?: string
  inputMode?: Model3DInputMode
  taskId?: string
  requires3DModel?: boolean
}

type GenerateInput = {
  prompt: string
  output?: string
  model?: string
  provider?: string
  modelVersion?: string
  inputMode?: Model3DInputMode
  inputImages?: Model3DInputImage[]
  outputFormat?: string
  cwd: string
  dryRun?: boolean
  keyFile?: string
  onProgress?: (message: string) => void | Promise<void>
}

type SlashInput = {
  input: string
  cwd: string
  provider?: string
  model?: string
  modelVersion?: string
  inputImages?: Model3DInputImage[]
  require3DModel?: boolean
}

const DEFAULT_DIR = "codegoblin-output/models"
const MODEL3D_HINT =
  "Select a 3D model with /models first, such as tripo/text-to-model or tripo/image-to-model. Tripo generation uses credits and requires confirmation."

function looksLike3DIntent(prompt: string) {
  return /\b(3d|mesh|model|glb|obj|tripo|generate a model|make a model|turn this into 3d)\b/i.test(prompt)
}

export const CodeGoblin3DCommand = {
  isSlash(input: string) {
    return input.trimStart().startsWith("/model3d")
  },
  async runSlash(input: SlashInput): Promise<Model3DCommandResult> {
    const parsed = parseModel3DArgs(input.input.trimStart().replace(/^\/model3d\b/, "").trim())
    if (!parsed.prompt && !(parsed.inputImages?.length || input.inputImages?.length)) {
      return {
        ok: false,
        message: 'Usage: /model3d "prompt" --output codegoblin-output/models/name.glb',
      }
    }
    return generateModel3D({
      provider: parsed.provider ?? input.provider,
      model: parsed.model ?? input.model,
      modelVersion: parsed.modelVersion ?? input.modelVersion,
      ...parsed,
      prompt: parsed.prompt ?? "",
      inputImages: parsed.inputImages?.length ? parsed.inputImages : input.inputImages,
      cwd: input.cwd,
      require3DModel: input.require3DModel && !parsed.provider && !parsed.model,
    })
  },
  generate: generateModel3D,
  describe: describeModel3D,
  detectInputMode,
  is3DModelSelection(provider?: string, model?: string) {
    const id = `${provider ?? ""}/${model ?? ""}`.toLowerCase()
    return id.includes("tripo") || id.includes("text-to-model") || id.includes("image-to-model")
  },
  shouldRoutePromptTo3D(prompt: string, provider?: string, model?: string) {
    if (!CodeGoblin3DCommand.is3DModelSelection(provider, model)) return false
    const text = prompt.trim()
    if (!text || text.startsWith("/")) return false
    if (/^(hi|hii+|hello|hey|yo|sup|thanks?|thank you|ok|okay|yes|no|how are you\??|what'?s up\??)[\s.!?]*$/i.test(text)) return false
    return true
  },
  looksLike3DIntent(prompt: string) {
    return looksLike3DIntent(prompt)
  },
}

function detectInputMode(input: {
  prompt: string
  model?: string
  provider?: string
  inputImages?: Model3DInputImage[]
  inputMode?: Model3DInputMode
}): Model3DInputMode {
  if (input.inputMode) return input.inputMode
  const provider = getModel3DProvider(input.provider)
  const model = provider.normalizeModel(input.model)
  if (model === "image-to-model" || (input.inputImages?.length ?? 0) > 0) return "image"
  return "text"
}

function describeModel3D(input: GenerateInput) {
  const provider = getModel3DProvider(input.provider)
  const root = path.resolve(input.cwd || process.cwd())
  const inputMode = detectInputMode(input)
  const model = provider.normalizeModel(input.model)
  const modelVersion = provider.normalizeModelVersion(input.modelVersion)
  const outputFormat = input.outputFormat?.trim() || "glb"
  const supported = !input.require3DModel || CodeGoblin3DCommand.is3DModelSelection(provider.id, model)
  return {
    provider: provider.id,
    model,
    modelVersion,
    inputMode,
    outputFormat,
    output: safeOutputPath(root, input.output, provider.fileExtension(outputFormat)),
    supported,
  }
}

async function generateModel3D(input: GenerateInput): Promise<Model3DCommandResult> {
  const provider = getModel3DProvider(input.provider)
  const root = path.resolve(input.cwd || process.cwd())
  const env = await loadLocalEnv(root, input.keyFile)
  const inputMode = detectInputMode(input)
  const model = provider.normalizeModel(input.model)
  const modelVersion = provider.normalizeModelVersion(input.modelVersion)
  const outputFormat = input.outputFormat?.trim() || "glb"
  const output = safeOutputPath(root, input.output, provider.fileExtension(outputFormat))

  if (input.require3DModel && !CodeGoblin3DCommand.is3DModelSelection(input.provider, input.model)) {
    return { ok: false, message: MODEL3D_HINT, requires3DModel: true, provider: provider.id, model, output, inputMode }
  }

  if (input.dryRun) {
    return {
      ok: true,
      provider: provider.id,
      model,
      modelVersion,
      inputMode,
      output,
      message: `3D dry run OK. CodeGoblin would generate via ${provider.id}/${model} (${inputMode}, ${modelVersion}) and save to ${output}. Tripo credits apply.`,
    }
  }

  const key = await findModel3DKey(env, provider.envKeys, provider.authProviderID)
  if (!key) {
    return {
      ok: false,
      provider: provider.id,
      model,
      modelVersion,
      inputMode,
      output,
      message: `No ${provider.name} key found. Set ${provider.envKeys.join(" or ")} locally${
        provider.authProviderID ? `, or connect the ${provider.name} provider,` : ""
      } then retry. CodeGoblin did not send this 3D request.`,
    }
  }

  const result = await provider.generate({
    prompt: input.prompt,
    model,
    modelVersion,
    inputMode,
    inputImages: input.inputImages,
    outputFormat,
    apiKey: key.value,
    onProgress: input.onProgress,
  })

  if (!result.ok) {
    return {
      ok: false,
      provider: provider.id,
      model,
      modelVersion,
      inputMode,
      output,
      taskId: result.taskId,
      message: result.message,
    }
  }

  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, Buffer.from(result.bytes))
  return {
    ok: true,
    provider: provider.id,
    model,
    modelVersion,
    inputMode,
    output,
    taskId: result.taskId,
    message: `3D model generated with ${provider.id}/${model} (${inputMode}, ${modelVersion}) and saved to ${output}.`,
  }
}

function parseModel3DArgs(input: string) {
  const result: {
    prompt: string
    provider?: string
    model?: string
    modelVersion?: string
    output?: string
    inputImages?: Model3DInputImage[]
  } = { prompt: "" }
  const tokens = tokenize(input)
  const promptParts: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--provider" && tokens[i + 1]) {
      result.provider = tokens[++i]
      continue
    }
    if (token === "--model" && tokens[i + 1]) {
      result.model = tokens[++i]
      continue
    }
    if (token === "--model-version" && tokens[i + 1]) {
      result.modelVersion = tokens[++i]
      continue
    }
    if ((token === "--output" || token === "-o") && tokens[i + 1]) {
      result.output = tokens[++i]
      continue
    }
    if ((token === "--input" || token === "-i") && tokens[i + 1]) {
      result.inputImages = result.inputImages ?? []
      result.inputImages.push({ path: tokens[++i] })
      continue
    }
    promptParts.push(token)
  }
  result.prompt = promptParts.join(" ").trim()
  return result
}

function tokenize(input: string) {
  const tokens: string[] = []
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

function safeOutputPath(root: string, output: string | undefined, extension: string) {
  const target = path.resolve(root, output || path.join(DEFAULT_DIR, `${timestamp()}.${extension}`))
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("3D output path must stay inside the current project directory.")
  }
  return target
}

async function loadLocalEnv(root: string, keyFile?: string) {
  const result: Record<string, string | undefined> = { ...process.env }
  const files = [process.env.CODEGOBLIN_ENV_FILE, keyFile, ...envFilesUp(root)].filter(
    (item): item is string => Boolean(item),
  )
  for (const file of files) {
    const resolved = path.resolve(root, file)
    const text = await fs.readFile(resolved, "utf8").catch(() => "")
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!match || result[match[1]]) continue
      result[match[1]] = unquoteEnv(match[2])
    }
  }
  return result
}

async function findModel3DKey(env: Record<string, string | undefined>, envKeys: string[], authProviderID?: string) {
  const local = envKeys
    .map((name) => (env[name] ? { value: env[name] as string, source: name } : undefined))
    .find(Boolean)
  if (local) return local
  if (env.CODEGOBLIN_MODEL3D_DISABLE_CONNECTED_AUTH === "1" || !authProviderID) return
  const key = await authKey(authProviderID)
  if (!key) return
  return { value: key, source: `connected ${authProviderID} provider` }
}

async function authKey(provider: string) {
  const file = path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
  const raw = await fs.readFile(file, "utf8").catch(() => "")
  if (!raw) return
  try {
    const data = JSON.parse(raw)
    const item = data?.[provider]
    if (item?.type === "api" && typeof item.key === "string") return item.key
  } catch {}
}

function envFilesUp(root: string) {
  const result: string[] = []
  let current = root
  for (;;) {
    result.push(path.join(current, ".env.local"), path.join(current, ".env"))
    const parent = path.dirname(current)
    if (parent === current || current === os.homedir()) return result
    current = parent
  }
}

function unquoteEnv(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}
