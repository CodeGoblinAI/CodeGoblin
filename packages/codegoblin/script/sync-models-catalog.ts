#!/usr/bin/env bun

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { experientialCatalog } from "../src/provider/experiential"
import { refuselessCatalog } from "../src/provider/refuseless"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(dir, "models")
const outFile = path.join(outDir, "api.json")
const source =
  process.env.CODEGOBLIN_MODELS_SYNC_URL || process.env.OPENCODE_MODELS_URL || "https://models.dev/api.json"

const experientialOnly = process.argv.includes("--experiential-only")
const refuselessOnly = process.argv.includes("--refuseless-only")
if (experientialOnly && refuselessOnly) throw new Error("Select only one provider-only refresh")
const providerOnly = experientialOnly || refuselessOnly
console.log(providerOnly ? "Updating provider in the existing catalog" : `Syncing models catalog from ${source}`)
const response = providerOnly ? undefined : await fetch(source)
if (response && !response.ok) {
  console.error(`Failed to fetch models catalog: ${response.status} ${response.statusText}`)
  process.exit(1)
}

const catalog: Record<string, unknown> = JSON.parse(
  providerOnly ? await Bun.file(outFile).text() : await response!.text(),
)
if (!refuselessOnly)
  catalog.explabs = await experientialCatalog().catch(async (error) => {
    if (experientialOnly) throw error
    const previous: Record<string, unknown> = await Bun.file(outFile)
      .json()
      .catch(() => ({}))
    if (!previous.explabs) throw error
    console.warn("Experiential Labs refresh failed; retaining its existing catalog and refreshing other providers.")
    return previous.explabs
  })
if (!experientialOnly)
  catalog.refuseless = await refuselessCatalog().catch(async (error) => {
    if (refuselessOnly) throw error
    const previous: Record<string, unknown> = await Bun.file(outFile)
      .json()
      .catch(() => ({}))
    if (!previous.refuseless) throw error
    console.warn("Refuseless refresh failed; retaining its existing catalog and refreshing other providers.")
    return previous.refuseless
  })
const text = JSON.stringify(catalog)
await fs.promises.mkdir(outDir, { recursive: true })
await Bun.write(outFile, text)
console.log(`Wrote ${outFile} (${text.length} bytes)`)
