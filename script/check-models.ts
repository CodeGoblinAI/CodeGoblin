import { PROVIDERS, kindOf } from "../src/core/providers"
import { apiKey } from "../src/core/auth"

/**
 * Does every model we list actually exist?
 *
 * Written after shipping "grok-imagine-image-speed", a model id nobody had
 * ever served. It sat in the picker looking exactly like a real one and
 * returned 404 the moment someone chose it. Guessing model ids is easy and
 * invisible; asking is neither.
 *
 * Only providers with an OpenAI-style /models endpoint and a key on this
 * machine can be checked. Everything else is reported as unchecked rather
 * than quietly counted as fine.
 *
 *   bun script/check-models.ts
 */

/** Where each provider lists what it serves, when it does so compatibly. */
const MODEL_ENDPOINTS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/models",
  zai: "https://api.z.ai/api/paas/v4/models",
  moonshotai: "https://api.moonshot.ai/v1/models",
  xai: "https://api.x.ai/v1/models",
  openai: "https://api.openai.com/v1/models",
}

async function served(providerId: string, key: string): Promise<Set<string> | undefined> {
  const endpoint = MODEL_ENDPOINTS[providerId]
  if (!endpoint) return undefined
  try {
    const response = await fetch(endpoint, { headers: { authorization: `Bearer ${key}` } })
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: { id?: string }[]; models?: { id?: string }[] }
    const rows = body.data ?? body.models ?? []
    return new Set(rows.map((row) => row.id).filter((id): id is string => typeof id === "string"))
  } catch {
    return undefined
  }
}

const problems: string[] = []
const unchecked: string[] = []

for (const provider of Object.values(PROVIDERS)) {
  const key = apiKey(provider.id)
  if (!key) {
    unchecked.push(`${provider.id} (not connected)`)
    continue
  }

  const available = await served(provider.id, key)
  if (!available) {
    unchecked.push(`${provider.id} (no compatible /models endpoint)`)
    continue
  }

  for (const model of provider.models) {
    const mark = available.has(model.id) ? "ok  " : "GONE"
    if (mark === "GONE") problems.push(`${provider.id}/${model.id}`)
    console.log(`${mark}  ${provider.id}/${model.id}`.padEnd(52) + kindOf(model))
  }
}

console.log("")
if (unchecked.length) console.log("unchecked: " + unchecked.join(", "))
if (problems.length) {
  console.log("")
  console.log(`${problems.length} model${problems.length === 1 ? "" : "s"} in the catalogue that the provider does not serve:`)
  for (const id of problems) console.log("  " + id)
  process.exit(1)
}
console.log("every checkable model exists.")
