import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const args = Bun.argv.slice(2)
const rawVariant = args.find((arg) => arg !== "list" && arg !== "runner" && !arg.startsWith("--")) ?? "01"
const showRunner = args.includes("--runner") || args.includes("runner")

if (args.includes("--list") || args.includes("list")) {
  for (let i = 1; i <= 47; i++) {
    const variant = String(i).padStart(2, "0")
    console.log(`bun run dev:header:${variant}`)
  }
  process.exit(0)
}

const numeric = Number(rawVariant.trim().replace(/^v/i, ""))

if (!Number.isInteger(numeric) || numeric < 1 || numeric > 47) {
  console.error(`Expected a header variant from 1 to 47, got: ${rawVariant}`)
  process.exit(1)
}

const variant = String(numeric).padStart(2, "0")
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

console.log(`Starting CodeGoblin TUI header variant ${variant}...`)
if (showRunner) {
  console.log("Tiny goblin footer runner enabled.")
}
console.log("Press Ctrl+C to stop this variant before trying another one.\n")

const child = Bun.spawn([process.execPath, "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEGOBLIN_HEADER_VARIANT: variant,
    ...(showRunner ? { CODEGOBLIN_FOOTER_ANIMATION: "1" } : {}),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await child.exited)
