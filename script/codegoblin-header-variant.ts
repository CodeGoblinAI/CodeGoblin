import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const args = Bun.argv.slice(2)

function getOptionValue(flag: string) {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)

  const index = args.indexOf(flag)
  if (index === -1) return undefined

  const next = args[index + 1]
  if (!next || next.startsWith("--")) return undefined
  return next
}

const rawVariant =
  args.find(
    (arg, index) =>
      arg !== "list" &&
      arg !== "list-runner" &&
      arg !== "runner" &&
      arg !== "--runner-variant" &&
      args[index - 1] !== "--runner-variant" &&
      !arg.startsWith("--"),
  ) ?? "01"
const showRunner =
  args.includes("--runner") ||
  args.includes("runner") ||
  args.includes("--runner-variant") ||
  Boolean(getOptionValue("--runner")) ||
  Boolean(getOptionValue("--runner-variant"))
const rawRunnerVariant = getOptionValue("--runner") ?? getOptionValue("--runner-variant") ?? "03"
const runnerVariantNames = {
  "01": "tiny classic",
  "02": "micro scout",
  "03": "round bobber",
  "04": "hooded runner",
  "05": "big ear scout",
  "06": "sneaksnout",
  "07": "rogue dagger",
  "08": "scar hood",
  "09": "squat bruiser",
  "10": "deluxe goblin",
} as const

if (args.includes("--list") || args.includes("list")) {
  for (let i = 1; i <= 47; i++) {
    const variant = String(i).padStart(2, "0")
    console.log(`bun run dev:header:${variant}`)
  }
  process.exit(0)
}

if (args.includes("--list-runner") || args.includes("list-runner")) {
  for (let i = 1; i <= 10; i++) {
    const runnerVariant = String(i).padStart(2, "0") as keyof typeof runnerVariantNames
    console.log(`bun run dev:runner:${runnerVariant}  # ${runnerVariantNames[runnerVariant]}`)
  }
  process.exit(0)
}

const numeric = Number(rawVariant.trim().replace(/^v/i, ""))

if (!Number.isInteger(numeric) || numeric < 1 || numeric > 47) {
  console.error(`Expected a header variant from 1 to 47, got: ${rawVariant}`)
  process.exit(1)
}

const runnerNumeric = Number(rawRunnerVariant.trim().replace(/^v/i, ""))

if (showRunner && (!Number.isInteger(runnerNumeric) || runnerNumeric < 1 || runnerNumeric > 10)) {
  console.error(`Expected a footer runner variant from 1 to 10, got: ${rawRunnerVariant}`)
  process.exit(1)
}

const variant = String(numeric).padStart(2, "0")
const runnerVariant = String(runnerNumeric).padStart(2, "0")
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

console.log(`Starting CodeGoblin TUI header variant ${variant}...`)
if (showRunner) {
  console.log(`Footer goblin runner ${runnerVariant} enabled (${runnerVariantNames[runnerVariant as keyof typeof runnerVariantNames]}).`)
}
console.log("Press Ctrl+C to stop this variant before trying another one.\n")

const child = Bun.spawn([process.execPath, "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEGOBLIN_HEADER_VARIANT: variant,
    ...(showRunner ? { CODEGOBLIN_FOOTER_ANIMATION: "1", CODEGOBLIN_FOOTER_VARIANT: runnerVariant } : {}),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await child.exited)
