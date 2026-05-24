import fs from "fs/promises"
import path from "path"

export type ImageCommandResult = {
  ok: boolean
  message: string
  output?: string
  model?: string
}

type GenerateInput = {
  prompt: string
  output?: string
  model?: string
  cwd: string
  dryRun?: boolean
}

type SlashInput = {
  input: string
  cwd: string
}

const DEFAULT_MODEL = "gemini-2.5-flash-image"
const DEFAULT_DIR = "codegoblin-output/images"

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
    return generateImage({ ...parsed, cwd: input.cwd })
  },
  generate: generateImage,
  parse: parseImageArgs,
}

async function generateImage(input: GenerateInput): Promise<ImageCommandResult> {
  const root = path.resolve(input.cwd || process.cwd())
  const output = safeOutputPath(root, input.output)
  const model = input.model || DEFAULT_MODEL

  if (input.dryRun) {
    return {
      ok: true,
      model,
      output,
      message: `Image dry run OK. Would save Gemini image output to ${output}`,
    }
  }

  const apiKey = findGeminiKey()
  if (!apiKey) {
    return {
      ok: false,
      model,
      output,
      message:
        "Gemini image generation is scaffolded but no key is configured. Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY locally, then retry.",
    }
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
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
      model,
      output,
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
      model,
      output,
      message: "Gemini response did not include inline image data.",
    }
  }

  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, Buffer.from(data, "base64"))

  return {
    ok: true,
    model,
    output,
    message: `Saved Gemini image output to ${output}`,
  }
}

function parseImageArgs(raw: string): Omit<GenerateInput, "cwd"> {
  const tokens = tokenize(raw)
  const rest: string[] = []
  let output: string | undefined
  let model: string | undefined
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

function findGeminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}
