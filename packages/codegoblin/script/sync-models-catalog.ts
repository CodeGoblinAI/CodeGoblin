#!/usr/bin/env bun

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { experientialCatalog } from "../src/provider/experiential"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(dir, "models")
const outFile = path.join(outDir, "api.json")
const source =
  process.env.CODEGOBLIN_MODELS_SYNC_URL || process.env.OPENCODE_MODELS_URL || "https://models.dev/api.json"

const experientialOnly = process.argv.includes("--experiential-only")
console.log(
  experientialOnly ? "Updating Experiential Labs in the existing catalog" : `Syncing models catalog from ${source}`,
)
const response = experientialOnly ? undefined : await fetch(source)
if (response && !response.ok) {
  console.error(`Failed to fetch models catalog: ${response.status} ${response.statusText}`)
  process.exit(1)
}

const catalog: Record<string, unknown> = JSON.parse(
  experientialOnly ? await Bun.file(outFile).text() : await response!.text(),
)
catalog.explabs = await experientialCatalog().catch(async (error) => {
  if (experientialOnly) throw error
  const previous: Record<string, unknown> = await Bun.file(outFile)
    .json()
    .catch(() => ({}))
  if (!previous.explabs) throw error
  console.warn("Experiential Labs refresh failed; retaining its existing catalog and refreshing other providers.")
  return previous.explabs
})
const text = JSON.stringify(catalog)
await fs.promises.mkdir(outDir, { recursive: true })
await Bun.write(outFile, text)
console.log(`Wrote ${outFile} (${text.length} bytes)`)
