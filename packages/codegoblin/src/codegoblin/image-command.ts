import fs from "fs/promises"
import os from "os"
import path from "path"
import { readConnectedProviderKey } from "./connected-auth"

export type ImageCommandResult = {
  ok: boolean
  message: string
  output?: string
  model?: string
  provider?: string
  cost?: number
  requiresImageModel?: boolean
  startedTask?: string
}

type GenerateInput = {
  prompt: string
  output?: string
  model?: string
  provider?: string
  cwd: string
  dryRun?: boolean
  keyFile?: string
  inputImages?: ImageInput[]
  useLastImage?: boolean
  requireImageModel?: boolean
}

type SlashInput = {
  input: string
  cwd: string
  provider?: string
  model?: string
  inputImages?: ImageInput[]
  useLastImage?: boolean
  requireImageModel?: boolean
}

export type ImageInput = {
  path?: string
  dataUrl?: string
  mime?: string
  filename?: string
}

type ImageProvider = "google" | "xai" | "openai" | "qwen"

type ResolvedImageKey = {
  value: string
  source: string
}

type ProviderGenerateInput = GenerateInput & {
  root: string
  output: string
  model: string
  apiKey: string
  keySource: string
}

type PlannedImage = {
  provider?: ImageProvider
  model?: string
  output?: string
  supported: boolean
  defaulted: boolean
}

const DEFAULT_MODEL = "gemini-2.5-flash-image"
const DEFAULT_DIR = "codegoblin-output/images"
const USAGE_FILE = "codegoblin-output/usage.json"
const IMAGE_MODEL_HINT =
  "Select an image model with /model first, such as google/gemini-2.5-flash-image, xai/grok-imagine-image-quality, openai/gpt-image-1, or qwen/wan2.7-image-pro. I did not send this prompt to a text model."

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
    return generateImage({
      provider: parsed.provider ?? input.provider,
      model: parsed.model ?? input.model,
      ...parsed,
      inputImages: parsed.inputImages?.length ? parsed.inputImages : input.inputImages,
      useLastImage: parsed.useLastImage || input.useLastImage,
      cwd: input.cwd,
      requireImageModel: input.requireImageModel && !parsed.provider && !parsed.model,
    })
  },
  generate: generateImage,
  parse: parseImageArgs,
  describe: describeImage,
  shouldRoutePromptToImage,
  looksLikeImageIntent,
  looksLikeImageEditRequest,
  looksLikeCasualText,
  isImageModelSelection,
  async usageSummary(cwd: string) {
    return usageSummary(cwd)
  },
}

async function generateImage(input: GenerateInput): Promise<ImageCommandResult> {
  const root = path.resolve(input.cwd || process.cwd())
  const output = safeOutputPath(root, input.output)
  const plan = planImage(input, output)

  if ((input.requireImageModel || input.provider || input.model) && !plan.supported) {
    return {
      ok: false,
      requiresImageModel: true,
      output,
      message: IMAGE_MODEL_HINT,
    }
  }

  const provider = plan.provider ?? "google"
  const model = plan.model ?? DEFAULT_MODEL
  const resolvedInput = await resolveInputImages(root, input)
  if (!resolvedInput.ok) {
    return {
      ok: false,
      model,
      provider,
      output,
      message: resolvedInput.message,
    }
  }

  if (input.dryRun) {
    const editHint = resolvedInput.inputImages.length
      ? ` and edit/reference ${resolvedInput.inputImages.length} input image${resolvedInput.inputImages.length === 1 ? "" : "s"}`
      : ""
    return {
      ok: true,
      model,
      provider,
      output,
      message: `Image dry run OK. CodeGoblin would generate with ${provider}/${model}${editHint} and save to ${output}`,
    }
  }

  const env = await loadLocalEnv(root, input.keyFile)
  const imageKey = await findImageKey(provider, env)
  if (!imageKey) {
    return {
      ok: false,
      model,
      provider,
      output,
      message: missingKeyMessage(provider),
    }
  }

  const result =
    provider === "xai"
      ? await generateXai({
          ...input,
          inputImages: resolvedInput.inputImages,
          root,
          output,
          model,
          apiKey: imageKey.value,
          keySource: imageKey.source,
        })
      : provider === "openai"
        ? await generateOpenAI({
            ...input,
            inputImages: resolvedInput.inputImages,
            root,
            output,
            model,
            apiKey: imageKey.value,
            keySource: imageKey.source,
          })
        : provider === "qwen"
          ? await generateQwen({
              ...input,
              inputImages: resolvedInput.inputImages,
              root,
              output,
              model,
              apiKey: imageKey.value,
              keySource: imageKey.source,
            })
          : await generateGemini({
              ...input,
              inputImages: resolvedInput.inputImages,
              root,
              output,
              model,
              apiKey: imageKey.value,
              keySource: imageKey.source,
            })
  if (result.ok) await recordUsage(root, result)
  return result
}

function describeImage(input: GenerateInput): PlannedImage {
  const root = path.resolve(input.cwd || process.cwd())
  const output = safeOutputPath(root, input.output)
  return planImage(input, output)
}

function planImage(input: Pick<GenerateInput, "provider" | "model">, output: string): PlannedImage {
  const provider = imageProviderFromSelection(input.provider, input.model)
  if (!provider) return { output, supported: false, defaulted: false }
  return {
    output,
    provider,
    model: normalizeModel(provider, input.model),
    supported: true,
    defaulted: !input.model,
  }
}

async function generateGemini(input: ProviderGenerateInput): Promise<ImageCommandResult> {
  const parts = [
    { text: input.prompt },
    ...(await imageInputParts(input.root, input.inputImages, { style: "gemini" })),
  ]
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
          parts,
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  }).catch((error) => error)

  if (!(response instanceof Response)) {
    return {
      ok: false,
      model: input.model,
      provider: "google",
      output: input.output,
      message: providerConnectionFailureMessage({
        label: "Gemini image",
        provider: "google",
        endpoint,
        error: response,
      }),
    }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return {
      ok: false,
      model: input.model,
      provider: "google",
      output: input.output,
      message: providerFailureMessage({
        label: "Gemini image",
        provider: "google",
        status: response.status,
        detail,
        keySource: input.keySource,
      }),
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
    message: successMessage("google", input.model, input.output, estimateCost("google", input.model)),
  }
}

async function generateXai(input: ProviderGenerateInput): Promise<ImageCommandResult> {
  const imageParts = await imageInputParts(input.root, input.inputImages, { style: "dataUrl" })
  const editing = imageParts.length > 0
  const response = await fetch(`https://api.x.ai/v1/images/${editing ? "edits" : "generations"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      response_format: "b64_json",
      ...(editing
        ? {
            image: {
              url: imageParts[0].dataUrl,
              type: "image_url",
            },
          }
        : {}),
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return {
      ok: false,
      model: input.model,
      provider: "xai",
      output: input.output,
      message: providerFailureMessage({
        label: "xAI image",
        provider: "xai",
        status: response.status,
        detail,
        keySource: input.keySource,
      }),
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
    message: successMessage("xai", input.model, input.output, estimateCost("xai", input.model)),
  }
}

async function generateOpenAI(input: ProviderGenerateInput): Promise<ImageCommandResult> {
  const imageParts = await imageInputParts(input.root, input.inputImages, { style: "dataUrl" })
  const editing = imageParts.length > 0
  let response: Response
  if (editing) {
    const form = new FormData()
    form.append("model", input.model)
    form.append("prompt", input.prompt)
    for (const [index, image] of imageParts.entries()) {
      const blob = new Blob([Buffer.from(image.data, "base64")], { type: image.mime })
      form.append("image[]", blob, image.filename || `input-${index + 1}.${extensionForMime(image.mime)}`)
    }
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
    })
  } else {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
      }),
    })
  }

  const saved = await saveOpenAIStyleResponse(response, {
    provider: "openai",
    model: input.model,
    output: input.output,
    label: "OpenAI image",
    keySource: input.keySource,
  })
  if (!saved.ok) return saved
  return {
    ...saved,
    cost: estimateCost("openai", input.model),
    message: successMessage("openai", input.model, input.output, estimateCost("openai", input.model)),
  }
}

async function generateQwen(input: ProviderGenerateInput): Promise<ImageCommandResult> {
  const imageParts = await imageInputParts(input.root, input.inputImages, { style: "dataUrl" })
  const content = [{ text: input.prompt }, ...imageParts.map((item) => ({ image: item.dataUrl }))]
  const created = await fetch("https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/image-generation/generation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
      "x-dashscope-async": "enable",
    },
    body: JSON.stringify({
      model: input.model,
      input: {
        messages: [
          {
            role: "user",
            content,
          },
        ],
      },
      parameters: {
        n: 1,
        size: "2K",
        watermark: false,
      },
    }),
  })

  if (!created.ok) {
    const detail = await created.text().catch(() => "")
    return {
      ok: false,
      model: input.model,
      provider: "qwen",
      output: input.output,
      message: providerFailureMessage({
        label: "Qwen image",
        provider: "qwen",
        status: created.status,
        detail,
        keySource: input.keySource,
      }),
    }
  }

  const json = (await created.json()) as any
  const taskID = json?.output?.task_id
  if (!taskID) {
    return {
      ok: false,
      model: input.model,
      provider: "qwen",
      output: input.output,
      message: "Qwen image request did not return a task id.",
    }
  }

  const completed = await pollQwenTask(taskID, input.apiKey)
  if (!completed.ok) {
    return {
      ok: false,
      model: input.model,
      provider: "qwen",
      output: input.output,
      startedTask: taskID,
      message: completed.message,
    }
  }

  const image = await fetch(completed.url)
  if (!image.ok) {
    return {
      ok: false,
      model: input.model,
      provider: "qwen",
      output: input.output,
      startedTask: taskID,
      message: `Qwen task ${taskID} succeeded, but image download failed with HTTP ${image.status}`,
    }
  }

  await fs.mkdir(path.dirname(input.output), { recursive: true })
  await fs.writeFile(input.output, Buffer.from(await image.arrayBuffer()))

  return {
    ok: true,
    model: input.model,
    provider: "qwen",
    output: input.output,
    startedTask: taskID,
    cost: estimateCost("qwen", input.model),
    message: successMessage("qwen", input.model, input.output, estimateCost("qwen", input.model)),
  }
}

async function pollQwenTask(taskID: string, apiKey: string) {
  const deadline = Date.now() + 120_000
  let lastStatus = "PENDING"
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    const response = await fetch(`https://dashscope-intl.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskID)}`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      return { ok: false as const, message: `Qwen task ${taskID} polling failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ""}` }
    }
    const json = (await response.json()) as any
    const output = json?.output ?? {}
    lastStatus = output.task_status ?? lastStatus
    if (lastStatus === "FAILED" || lastStatus === "CANCELED" || lastStatus === "UNKNOWN") {
      return { ok: false as const, message: `Qwen task ${taskID} ended with ${lastStatus}${output.message ? `: ${output.message}` : ""}` }
    }
    if (lastStatus !== "SUCCEEDED") continue
    const url =
      output.choices?.[0]?.message?.content?.find?.((item: any) => typeof item?.image === "string")?.image ??
      output.results?.[0]?.url ??
      output.results?.[0]?.image
    if (typeof url === "string" && url) return { ok: true as const, url }
    return { ok: false as const, message: `Qwen task ${taskID} succeeded but did not include an image URL.` }
  }
  return { ok: false as const, message: `Qwen task ${taskID} is still ${lastStatus}; try again later or inspect the task in Qwen Cloud.` }
}

async function saveOpenAIStyleResponse(
  response: Response,
  input: { provider: ImageProvider; model: string; output: string; label: string; keySource: string },
): Promise<ImageCommandResult> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    return {
      ok: false,
      model: input.model,
      provider: input.provider,
      output: input.output,
      message: providerFailureMessage({
        label: input.label,
        provider: input.provider,
        status: response.status,
        detail,
        keySource: input.keySource,
      }),
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
        provider: input.provider,
        output: input.output,
        message: `${input.label} returned an image URL, but download failed with HTTP ${image.status}`,
      }
    }
    await fs.writeFile(input.output, Buffer.from(await image.arrayBuffer()))
  } else {
    return {
      ok: false,
      model: input.model,
      provider: input.provider,
      output: input.output,
      message: `${input.label} response did not include image data or an image URL.`,
    }
  }
  return {
    ok: true,
    model: input.model,
    provider: input.provider,
    output: input.output,
    message: successMessage(input.provider, input.model, input.output, estimateCost(input.provider, input.model)),
  }
}

function parseImageArgs(raw: string): Omit<GenerateInput, "cwd"> {
  const tokens = tokenize(raw)
  const rest: string[] = []
  let output: string | undefined
  let model: string | undefined
  let provider: string | undefined
  let keyFile: string | undefined
  const inputImages: ImageInput[] = []
  let dryRun = false
  let useLastImage = false

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
    if (token === "--input" || token === "--image") {
      const value = tokens[++i]
      if (value) inputImages.push({ path: value })
      continue
    }
    if (token.startsWith("--input=")) {
      inputImages.push({ path: token.slice("--input=".length) })
      continue
    }
    if (token.startsWith("--image=")) {
      inputImages.push({ path: token.slice("--image=".length) })
      continue
    }
    if (token === "--last" || token === "--last-image" || token === "--previous-image") {
      useLastImage = true
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
    inputImages,
    useLastImage,
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

function normalizeProvider(provider?: string, model?: string): ImageProvider {
  const raw = `${provider ?? ""}/${model ?? ""}`.toLowerCase()
  if (raw.includes("qwen") || raw.includes("wan") || raw.includes("dashscope") || raw.includes("alibaba")) return "qwen"
  if (raw.includes("openai") || raw.includes("gpt-image") || raw.includes("dall-e")) return "openai"
  if (raw.includes("xai") || raw.includes("grok")) return "xai"
  return "google"
}

function imageProviderFromSelection(provider?: string, model?: string): ImageProvider | undefined {
  if (!provider && !model) return
  const providerRaw = provider?.toLowerCase() ?? ""
  const modelRaw = model?.toLowerCase() ?? ""

  if (!modelRaw) {
    if (providerRaw.includes("qwen") || providerRaw.includes("dashscope") || providerRaw.includes("alibaba")) return "qwen"
    if (providerRaw.includes("openai")) return "openai"
    if (providerRaw.includes("xai")) return "xai"
    if (providerRaw.includes("google") || providerRaw.includes("gemini")) return "google"
    return
  }

  if (modelRaw.includes("wan2.") || modelRaw.includes("qwen-image") || modelRaw.includes("image-edit")) return "qwen"
  if (modelRaw.includes("gpt-image") || modelRaw.includes("chatgpt-image") || modelRaw.includes("dall-e")) return "openai"
  if (modelRaw.includes("grok-imagine-image")) return "xai"
  if (
    modelRaw.includes("flash-image") ||
    modelRaw.includes("imagen") ||
    modelRaw.includes("nanobanana") ||
    modelRaw.includes("nano-banana")
  )
    return "google"
}

function normalizeModel(provider: ImageProvider, model?: string) {
  const raw = model?.trim()
  if (!raw) {
    if (provider === "xai") return "grok-imagine-image-quality"
    if (provider === "openai") return "gpt-image-1"
    if (provider === "qwen") return "wan2.7-image-pro"
    return DEFAULT_MODEL
  }
  const lower = raw.toLowerCase().replace(/\s+/g, "-")
  if (lower === "nanobanana" || lower === "nano-banana" || lower === "banana") return DEFAULT_MODEL
  if (provider === "xai" && (lower === "grok-imagine-image" || lower === "grok-imagine")) return "grok-imagine-image-quality"
  if (provider === "qwen" && (lower === "qwen-image" || lower === "qwen-image-pro")) return "wan2.7-image-pro"
  if (provider === "qwen" && lower === "qwen-image-edit") return "wan2.7-image-edit"
  return raw
}

function isImageModelSelection(input: { providerID?: string; modelID?: string; outputImage?: boolean }) {
  if (input.outputImage) return true
  if (!input.providerID && !input.modelID) return false
  return Boolean(imageProviderFromSelection(input.providerID, input.modelID))
}

function shouldRoutePromptToImage(input: {
  prompt: string
  providerID?: string
  modelID?: string
  outputImage?: boolean
}) {
  return isImageModelSelection(input) && !looksLikeCasualText(input.prompt)
}

function looksLikeImageIntent(prompt: string) {
  return /\b(create|generate|make|draw|render|design|edit|change|transform|paint)\b.{0,100}\b(image|picture|photo|logo|mascot|illustration|avatar|icon|cat|dog|horse|goblin|car|flames?|red|style)\b/i.test(prompt)
}

function looksLikeImageEditRequest(prompt: string) {
  return /\b(edit|change|modify|adjust|retouch|inpaint|outpaint|replace|remove|add)\b.{0,120}\b(image|picture|photo|it|this|that|last|previous|same)\b/i.test(prompt) ||
    /\b(make|turn|paint)\s+(it|this|that|him|her|them|the\s+(last|previous|same)\s+(image|picture|photo)|the\s+(subject|character|person|goblin|mascot|object))\b/i.test(prompt) ||
    /\b(last|previous|same)\s+(image|picture|photo)\b/i.test(prompt)
}

function looksLikeCasualText(prompt: string) {
  return /^(hi|hii+|hello|hey|yo|sup|thanks?|thank you|ok|okay|yes|no|how are you\??|what'?s up\??)[\s.!?]*$/i.test(prompt.trim())
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
    const text = await fs.readFile(resolved, "utf8").catch(() => "")
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
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

async function findImageKey(provider: ImageProvider, env: Record<string, string | undefined>) {
  const local = localImageKey(provider, env)
  if (local) return local
  if (env.CODEGOBLIN_IMAGE_DISABLE_CONNECTED_AUTH === "1") return

  const key = await readConnectedProviderKey(authProvider(provider))
  if (!key) return
  return { value: key, source: `connected ${authProvider(provider)} provider` } satisfies ResolvedImageKey
}

function localImageKey(provider: ImageProvider, env: Record<string, string | undefined>) {
  const names =
    provider === "xai"
      ? ["XAI_API_KEY"]
      : provider === "openai"
        ? ["OPENAI_API_KEY"]
        : provider === "qwen"
          ? ["DASHSCOPE_API_KEY", "QWEN_API_KEY", "ALIBABA_API_KEY"]
          : ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]

  return names
    .map((name) => (env[name] ? ({ value: env[name], source: name } satisfies ResolvedImageKey) : undefined))
    .filter((item): item is ResolvedImageKey => Boolean(item))[0]
}

function authProvider(provider: ImageProvider) {
  if (provider === "qwen") return "alibaba"
  return provider
}

function estimateCost(provider: string, model: string) {
  if (provider === "xai") return 0.02
  if (provider === "openai") return model.includes("mini") ? 0.011 : 0.042
  if (provider === "qwen") return 0
  if (model.includes("flash-image")) return 0.039
  return 0
}

function missingKeyMessage(provider: ImageProvider) {
  if (provider === "xai") return "No xAI image key found. Set XAI_API_KEY locally or connect the xai provider, then retry."
  if (provider === "openai") return "No OpenAI image key found. Set OPENAI_API_KEY locally or connect the openai provider, then retry."
  if (provider === "qwen") return "No Qwen/DashScope image key found. Set DASHSCOPE_API_KEY locally or connect the alibaba provider, then retry."
  return "No Gemini image key found. Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY locally or connect the google provider, then retry."
}

function providerFailureMessage(input: {
  label: string
  provider: ImageProvider
  status: number
  detail: string
  keySource: string
}) {
  const detail = providerErrorDetail(input.detail)
  const code = detail.reason ?? detail.status
  const reason = code ? ` ${code}` : ""
  const auth = imageAuthFailureHint(input.provider, input.status, input.keySource, detail)
  if (auth) {
    return [
      `${input.label} request was rejected by the provider (HTTP ${input.status}${reason}).`,
      auth,
      detail.message ? `Provider said: ${detail.message}` : undefined,
    ]
      .filter((item): item is string => Boolean(item))
      .join(" ")
  }
  return `${input.label} request failed with HTTP ${input.status}${detail.message ? `: ${detail.message}` : ""}`
}

function providerConnectionFailureMessage(input: {
  label: string
  provider: ImageProvider
  endpoint: string
  error: unknown
}) {
  return [
    `${input.label} request could not connect to ${safeOrigin(input.endpoint)}.`,
    `Provider: ${input.provider}.`,
    "Check network/VPN/firewall/proxy access and that the provider API is reachable from this machine.",
    `Original error: ${errorText(input.error)}`,
  ].join(" ")
}

function safeOrigin(endpoint: string) {
  try {
    return new URL(endpoint).origin
  } catch {
    return "the provider API"
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "unknown network error"
}

function imageAuthFailureHint(
  provider: ImageProvider,
  status: number,
  keySource: string,
  detail: { message?: string; status?: string; reason?: string },
) {
  const text = [detail.message, detail.status, detail.reason].filter(Boolean).join(" ").toLowerCase()
  const looksAuth = status === 401 || status === 403 || /api[_ -]?key|auth|credential|permission|unauth/.test(text)
  if (!looksAuth) return
  if (provider === "google" && isEnvKeySource(keySource)) {
    return `CodeGoblin used ${keySource} from your environment before checking connected Google auth. Update or remove that environment key, restart CodeGoblin, then retry.`
  }
  if (isEnvKeySource(keySource)) {
    return `CodeGoblin used ${keySource} from your environment. Update or remove that environment key, restart CodeGoblin, then retry.`
  }
  return `CodeGoblin used the ${keySource}. Reconnect that provider or check that the key is valid, unrestricted for this API, and enabled in the provider project.`
}

function isEnvKeySource(source: string) {
  return source.endsWith("_API_KEY") || source === "DASHSCOPE_API_KEY"
}

function providerErrorDetail(detail: string): { message?: string; status?: string; reason?: string } {
  const parsed = parseJsonObject(detail)
  const error = asRecord(parsed?.error)
  if (!error) return { message: detail.trim().slice(0, 300) || undefined }
  return {
    message: stringValue(error.message),
    status: stringValue(error.status),
    reason: stringValue(error.reason) ?? providerErrorReason(error.details),
  }
}

function parseJsonObject(text: string) {
  if (!text.trim()) return
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return
  }
}

function providerErrorReason(details: unknown) {
  if (!Array.isArray(details)) return
  return details
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => stringValue(item.reason))
    .filter((item): item is string => Boolean(item))[0]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  if (typeof value !== "string") return
  return value
}

function successMessage(provider: string, model: string, output: string, cost?: number) {
  return `Image generated with ${provider}/${model} and saved to ${output}. Goblin pocketed ~${formatCost(cost)} from the token pile.`
}

async function resolveInputImages(root: string, input: Pick<GenerateInput, "inputImages" | "prompt" | "useLastImage">) {
  const explicit = (input.inputImages ?? []).filter((item) => item.path || item.dataUrl)
  if (explicit.length > 0) return { ok: true as const, inputImages: explicit }

  if (!input.useLastImage && !looksLikeImageEditRequest(input.prompt)) {
    return { ok: true as const, inputImages: [] }
  }

  const last = await lastGeneratedImage(root)
  if (last) {
    return {
      ok: true as const,
      inputImages: [{ path: last.path, filename: path.basename(last.path) }],
    }
  }

  return {
    ok: false as const,
    message:
      "No previous CodeGoblin image was found to edit. Attach an image, pass --image <path>, use --last-image after generating one, or generate an image first.",
  }
}

async function lastGeneratedImage(root: string) {
  const existing = await fs.readFile(path.join(root, USAGE_FILE), "utf8").then((x) => JSON.parse(x)).catch(() => undefined)
  const output = stringValue(asRecord(asRecord(existing)?.last)?.output)
  if (!output) return
  const target = safeInputImagePathOrUndefined(root, output)
  if (!target) return
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat?.isFile()) return
  return {
    path: path.relative(root, target) || path.basename(target),
    absolute: target,
  }
}

async function imageInputParts(
  root: string,
  inputs: ImageInput[] | undefined,
  opts: { style: "gemini" | "dataUrl" },
): Promise<Array<any>> {
  const images = await normalizeInputImages(root, inputs)
  if (opts.style === "dataUrl") return images
  return images.map((item) => ({
    inline_data: {
      mime_type: item.mime,
      data: item.data,
    },
  }))
}

async function normalizeInputImages(root: string, inputs: ImageInput[] | undefined) {
  const result: Array<{ data: string; dataUrl: string; mime: string; filename?: string }> = []
  for (const item of inputs ?? []) {
    if (result.length >= 9) break
    if (item.dataUrl) {
      const parsed = parseDataUrl(item.dataUrl, item.mime, item.filename)
      if (parsed) result.push(parsed)
      continue
    }
    if (!item.path) continue
    const resolved = safeInputImagePath(root, item.path)
    const data = await fs.readFile(resolved)
    const mime = item.mime || mimeFromPath(resolved)
    if (!mime.startsWith("image/")) continue
    const base64 = data.toString("base64")
    result.push({
      data: base64,
      dataUrl: `data:${mime};base64,${base64}`,
      mime,
      filename: item.filename || path.basename(resolved),
    })
  }
  return result
}

function safeInputImagePath(root: string, input: string) {
  const target = path.resolve(root, input)
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Input image path must stay inside the current project directory.")
  }
  return target
}

function safeInputImagePathOrUndefined(root: string, input: string) {
  try {
    return safeInputImagePath(root, input)
  } catch {
    return
  }
}

function parseDataUrl(dataUrl: string, fallbackMime?: string, filename?: string) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) return
  const mime = fallbackMime || match[1]
  if (!mime.startsWith("image/")) return
  return {
    data: match[2],
    dataUrl,
    mime,
    filename,
  }
}

function mimeFromPath(file: string) {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".webp") return "image/webp"
  if (ext === ".gif") return "image/gif"
  if (ext === ".bmp") return "image/bmp"
  return "image/png"
}

function extensionForMime(mime: string) {
  if (mime === "image/jpeg") return "jpg"
  if (mime === "image/webp") return "webp"
  if (mime === "image/gif") return "gif"
  if (mime === "image/bmp") return "bmp"
  return "png"
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
  existing.providers = existing.providers && typeof existing.providers === "object" ? existing.providers : {}
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
