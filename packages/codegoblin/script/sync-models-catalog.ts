#!/usr/bin/env bun

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(dir, "models")
const outFile = path.join(outDir, "api.json")
const source = process.env.CODEGOBLIN_MODELS_SYNC_URL || process.env.OPENCODE_MODELS_URL || "https://models.dev/api.json"

console.log(`Syncing models catalog from ${source}`)
const response = await fetch(source)
if (!response.ok) {
  console.error(`Failed to fetch models catalog: ${response.status} ${response.statusText}`)
  process.exit(1)
}

const text = await response.text()
await fs.promises.mkdir(outDir, { recursive: true })
await Bun.write(outFile, text)
console.log(`Wrote ${outFile} (${text.length} bytes)`)
