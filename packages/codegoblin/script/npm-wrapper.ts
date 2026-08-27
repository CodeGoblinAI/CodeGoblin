export function npmWrapper(input: {
  command: string
  nativeCommand: string
  productName: string
  packageName: string
}) {
  return `#!/usr/bin/env node
import childProcess from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const binDir = path.dirname(fileURLToPath(import.meta.url))
const packageFile = path.join(binDir, "..", "package.json")
const native = path.join(binDir, "${input.nativeCommand}.exe")
const args = process.argv.slice(2)

if (!fs.existsSync(native)) {
  console.error("Error: ${input.productName}'s native binary was not installed.")
  console.error("")
  console.error("This can happen when installing with --ignore-scripts or with a package manager")
  console.error("that does not run postinstall scripts by default.")
  console.error("")
  console.error("To fix this, run:")
  console.error("  cd node_modules/${input.packageName} && node postinstall.mjs")
  process.exit(1)
}

function updateRequest() {
  if (process.platform !== "win32") return
  if (args[0] !== "update" && args[0] !== "upgrade") return

  let method
  let target
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--method" || arg === "-m") {
      method = args[++i]
      continue
    }
    if (arg.startsWith("--method=")) {
      method = arg.slice("--method=".length)
      continue
    }
    if (!arg.startsWith("-") && !target) target = arg
  }

  if (method && method !== "npm") return
  if (target && !/^v?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(target)) return
  return target?.replace(/^v/, "") || "latest"
}

function runNpmUpdate(target) {
  let current = "unknown"
  try {
    current = JSON.parse(fs.readFileSync(packageFile, "utf8")).version || current
  } catch {}

  console.log("")
  console.log("${input.productName} updater")
  console.log(\`Updating [36m\${current}[0m → [36m\${target}[0m with npm\`)
  console.log("The command stays open until npm restores the cg and codegoblin launchers.")
  console.log("")

  const started = Date.now()
  const heartbeat = setInterval(() => {
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000))
    console.log(\`Still updating... \${seconds}s elapsed\`)
  }, 10000)
  heartbeat.unref()

  const npm = childProcess.spawn(
    "npm",
    ["install", "--global", "${input.packageName}@" + target],
    {
      stdio: "inherit",
      shell: true,
      windowsHide: true,
      env: process.env,
    },
  )

  npm.on("error", (error) => {
    clearInterval(heartbeat)
    console.error("Update failed: " + error.message)
    process.exit(1)
  })

  npm.on("exit", (code, signal) => {
    clearInterval(heartbeat)
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    if (code !== 0) {
      console.error(\`Update failed (npm exit code \${code ?? "unknown"}).\`)
      process.exit(typeof code === "number" ? code : 1)
    }
    if (!fs.existsSync(native)) {
      console.error("Update finished, but the CodeGoblin binary is missing. Run npm install -g ${input.packageName} to repair it.")
      process.exit(1)
    }
    console.log("")
    console.log("✓ ${input.productName} update complete. The cg command is ready.")
    process.exit(0)
  })
}

const target = updateRequest()
if (target) runNpmUpdate(target)
else {
  const child = childProcess.spawn(native, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEGOBLIN: "1",
      CODEGOBLIN_CLI_NAME: "${input.command}",
      OPENCODE: "1",
    },
  })

  child.on("error", (error) => {
    console.error(error.message)
    process.exit(1)
  })

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(typeof code === "number" ? code : 0)
  })
}
`
}
