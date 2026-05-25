import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const rawVariant = Bun.argv[2] ?? "01"

if (rawVariant === "--list" || rawVariant === "list") {
  for (let i = 1; i <= 20; i++) {
    const variant = String(i).padStart(2, "0")
    console.log(`bun run dev:header:${variant}`)
  }
  process.exit(0)
}

const numeric = Number(rawVariant.trim().replace(/^v/i, ""))

if (!Number.isInteger(numeric) || numeric < 1 || numeric > 20) {
  console.error(`Expected a header variant from 1 to 20, got: ${rawVariant}`)
  process.exit(1)
}

const variant = String(numeric).padStart(2, "0")
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

console.log(`Starting CodeGoblin TUI header variant ${variant}...`)
console.log("Press Ctrl+C to stop this variant before trying another one.\n")

const child = Bun.spawn([process.execPath, "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEGOBLIN_HEADER_VARIANT: variant,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await child.exited)
