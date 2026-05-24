import fs from "fs/promises"
import os from "os"
import path from "path"

export type ImageCommandResult = {
  ok: boolean
  message: string
  output?: string
  model?: string
  provider?: string
  cost?: number
}

type GenerateInput = {
  prompt: string
  output?: string
  model?: string
  provider?: string
  cwd: string
  dryRun?: boolean
  keyFile?: string
}

type SlashInput = {
  input: string
  cwd: string
  provider?: string
  model?: string
}

const DEFAULT_MODEL = "gemini-2.5-flash-image"
const DEFAULT_DIR = "codegoblin-output/images"
const USAGE_FILE = "codegoblin-output/usage.json"

export const CodeGoblinImageCommand = {
  isSlash(input: string) {
    return input.trimStart().startsWith("/image")
  },
  async runSlash(input: SlashInput): Promise<ImageCommandResult> {
    const parsed = parseImageArgs(input.input.trimStart().replace(/^\/image\b/, "").trim())
    if (!parsed.prompt) {
      return {
        ok: false,
        message: 'Usage: /image "prompt" --output codegoblin-output/images/name.png',
      }
    }
    return generateImage({ provider: input.provider, model: input.model, ...parsed, cwd: input.cwd })
  },
  generate: generateImage,
  parse: parseImageArgs,
  shouldRoutePromptToImage,
  async usageSummary(cwd: string) {
    return usageSummary(cwd)
  },
}

async function generateImage(input: GenerateInput): Promise<ImageCommandResult> {
  const root = path.resolve(input.cwd || process.cwd())
  const output = safeOutputPath(root, input.output)
  const provider = normalizeProvider(input.provider, input.model)
  const model = normalizeModel(provider, input.model)

  if (input.dryRun) {
    return {
      ok: true,
      model,
      provider,
      output,
      message: `Image dry run OK. The goblin would save ${provider}/${model} output to ${output}`,
    }
  }

  const env = await loadLocalEnv(root, input.keyFile)
  const apiKey = await findImageKey(provider, env)
  if (!apiKey) {
    return {
      ok: false,
      model,
      provider,
      output,
      message:
        provider === "xai"
          ? "No xAI image key found. Set XAI_API_KEY locally or connect the xai provider, then retry."
          : "No Gemini image key found. Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY locally or connect the google provider, then retry.",
    }
  }

  const result = provider === "xai" ? await generateXai({ ...input, root, output, model, apiKey }) : await generateGemini({ ...input, root, output, model, apiKey })
  if (result.ok) await recordUsage(root, result)
  return result
}

async function generateGemini(input: GenerateInput & { root: string; output: string; model: string; apiKey: string }): Promise<ImageCommandResult> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: input.prompt }],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return {
      ok: false,
      model: input.model,
      provider: "google",
      output: input.output,
      message: `Gemini image request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    }
  }

  const json = (await response.json()) as any
  const part = json?.candidates?.[0]?.content?.parts?.find((item: any) => item.inlineData?.data || item.inline_data?.data)
  const inline = part?.inlineData ?? part?.inline_data
  const data = inline?.data
  if (!data || typeof data !== "string") {
    return {
      ok: false,
      model: input.model,
      provider: "google",
      output: input.output,
      message: "Gemini response did not include inline image data.",
    }
  }

  await fs.mkdir(path.dirname(input.output), { recursive: true })
  await fs.writeFile(input.output, Buffer.from(data, "base64"))

  return {
    ok: true,
    model: input.model,
    provider: "google",
    output: input.output,
    cost: estimateCost("google", input.model),
    message: `Saved Gemini image output to ${input.output}. Goblin ate ~${formatCost(estimateCost("google", input.model))} in tokens and hoarded the receipt.`,
  }
}

async function generateXai(input: GenerateInput & { root: string; output: string; model: string; apiKey: string }): Promise<ImageCommandResult> {
  const response = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      response_format: "b64_json",
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return {
      ok: false,
      model: input.model,
      provider: "xai",
      output: input.output,
      message: `xAI image request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    }
  }

  const json = (await response.json()) as any
  const data = json?.data?.[0]?.b64_json
  const url = json?.data?.[0]?.url
  await fs.mkdir(path.dirname(input.output), { recursive: true })
  if (typeof data === "string" && data.length) {
    await fs.writeFile(input.output, Buffer.from(data, "base64"))
  } else if (typeof url === "string" && url) {
    const image = await fetch(url)
    if (!image.ok) {
      return {
        ok: false,
        model: input.model,
        provider: "xai",
        output: input.output,
        message: `xAI returned an image URL, but download failed with HTTP ${image.status}`,
      }
    }
    await fs.writeFile(input.output, Buffer.from(await image.arrayBuffer()))
  } else {
    return {
      ok: false,
      model: input.model,
      provider: "xai",
      output: input.output,
      message: "xAI response did not include image data or an image URL.",
    }
  }

  return {
    ok: true,
    model: input.model,
    provider: "xai",
    output: input.output,
    cost: estimateCost("xai", input.model),
    message: `Saved xAI image output to ${input.output}. Goblin ate ~${formatCost(estimateCost("xai", input.model))} in tokens and hoarded the receipt.`,
  }
}

function parseImageArgs(raw: string): Omit<GenerateInput, "cwd"> {
  const tokens = tokenize(raw)
  const rest: string[] = []
  let output: string | undefined
  let model: string | undefined
  let provider: string | undefined
  let keyFile: string | undefined
  let dryRun = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "--output" || token === "-o") {
      output = tokens[++i]
      continue
    }
    if (token.startsWith("--output=")) {
      output = token.slice("--output=".length)
      continue
    }
    if (token === "--model") {
      model = tokens[++i]
      continue
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length)
      continue
    }
    if (token === "--provider") {
      provider = tokens[++i]
      continue
    }
    if (token.startsWith("--provider=")) {
      provider = token.slice("--provider=".length)
      continue
    }
    if (token === "--key-file") {
      keyFile = tokens[++i]
      continue
    }
    if (token.startsWith("--key-file=")) {
      keyFile = token.slice("--key-file=".length)
      continue
    }
    if (token === "--dry-run") {
      dryRun = true
      continue
    }
    rest.push(token)
  }

  return {
    prompt: rest.join(" ").trim(),
    output,
    model,
    provider,
    keyFile,
    dryRun,
  }
}

function tokenize(raw: string) {
  const result: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let escape = false

  for (const char of raw) {
    if (escape) {
      current += char
      escape = false
      continue
    }
    if (char === "\\") {
      escape = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) result.push(current)
  return result
}

function safeOutputPath(root: string, output?: string) {
  const target = path.resolve(root, output || path.join(DEFAULT_DIR, `${timestamp()}.png`))
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Image output path must stay inside the current project directory.")
  }
  return target
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function normalizeProvider(provider?: string, model?: string) {
  const raw = `${provider ?? ""}/${model ?? ""}`.toLowerCase()
  if (raw.includes("xai") || raw.includes("grok")) return "xai"
  return "google"
}

function normalizeModel(provider: string, model?: string) {
  const raw = model?.trim()
  if (!raw) return provider === "xai" ? "grok-imagine-image-quality" : DEFAULT_MODEL
  const lower = raw.toLowerCase().replace(/\s+/g, "-")
  if (lower === "nanobanana" || lower === "nano-banana" || lower === "banana") return DEFAULT_MODEL
  if (provider === "xai" && (lower === "grok-imagine-image" || lower === "grok-imagine")) return "grok-imagine-image-quality"
  return raw
}

function shouldRoutePromptToImage(input: {
  prompt: string
  providerID?: string
  modelID?: string
  outputImage?: boolean
}) {
  if (input.outputImage) return true
  const model = `${input.providerID ?? ""}/${input.modelID ?? ""}`.toLowerCase()
  if (model.includes("grok-imagine") || model.includes("image") || model.includes("nanobanana")) return true
  return /\b(create|generate|make|draw|render)\b.{0,80}\b(image|picture|photo|logo|mascot|illustration|avatar|icon|cat|dog)\b/i.test(input.prompt)
}

async function loadLocalEnv(root: string, keyFile?: string) {
  const env: Record<string, string | undefined> = { ...process.env }
  const files = [
    process.env.CODEGOBLIN_ENV_FILE,
    process.env.CODEGOBLIN_GEMINI_ENV_FILE,
    keyFile,
    ...envFilesUp(root),
  ].filter((item): item is string => Boolean(item))
  for (const file of files) {
    const resolved = path.resolve(root, file)
    if (
      !resolved.startsWith(root) &&
      file !== process.env.CODEGOBLIN_ENV_FILE &&
      file !== process.env.CODEGOBLIN_GEMINI_ENV_FILE &&
      file !== keyFile
    )
      continue
    const text = await fs.readFile(resolved, "utf8").catch(() => "")
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!match) continue
      if (match[1] in env && env[match[1]]) continue
      env[match[1]] = unquoteEnv(match[2])
    }
  }
  return env
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

async function findImageKey(provider: string, env: Record<string, string | undefined>) {
  if (provider === "xai") return env.XAI_API_KEY || (await authKey("xai"))
  return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || (await authKey("google"))
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

function estimateCost(provider: string, model: string) {
  if (provider === "xai") return 0.02
  if (model.includes("flash-image")) return 0.039
  return 0
}

function formatCost(cost = 0) {
  return `$${cost.toFixed(cost < 0.01 ? 4 : 3)}`
}

async function recordUsage(root: string, result: ImageCommandResult) {
  const file = path.join(root, USAGE_FILE)
  const existing = await fs.readFile(file, "utf8").then((x) => JSON.parse(x)).catch(() => ({
    images: 0,
    estimatedCost: 0,
    providers: {},
    last: undefined,
  }))
  const provider = result.provider || "unknown"
  existing.images = Number(existing.images || 0) + 1
  existing.estimatedCost = Number(existing.estimatedCost || 0) + Number(result.cost || 0)
  existing.providers[provider] = Number(existing.providers[provider] || 0) + 1
  existing.last = {
    at: new Date().toISOString(),
    provider,
    model: result.model,
    output: result.output,
    estimatedCost: result.cost || 0,
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(existing, null, 2))
}

async function usageSummary(cwd: string) {
  const root = path.resolve(cwd || process.cwd())
  const file = path.join(root, USAGE_FILE)
  const existing = await fs.readFile(file, "utf8").then((x) => JSON.parse(x)).catch(() => undefined)
  if (!existing) return "No CodeGoblin image usage yet. The goblin's pouch is empty."
  return [
    "CodeGoblin local usage",
    `Images generated: ${existing.images ?? 0}`,
    `Estimated tokens eaten: ${formatCost(Number(existing.estimatedCost || 0))}`,
    `By provider: ${Object.entries(existing.providers ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
    existing.last ? `Last output: ${existing.last.output}` : "",
  ].filter(Boolean).join("\n")
}
