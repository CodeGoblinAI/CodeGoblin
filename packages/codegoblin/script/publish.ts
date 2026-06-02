#!/usr/bin/env bun
import { $ } from "bun"
import fs from "fs"
import path from "path"
import pkg from "../package.json"
import { Script } from "@codegoblin/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const dryRun = process.argv.includes("--dry-run") || process.env.CODEGOBLIN_PUBLISH_DRY_RUN === "1"
const product = {
  name: "CodeGoblin",
  npm: process.env.CODEGOBLIN_NPM_PACKAGE || "codegoblin",
  npmScope: process.env.CODEGOBLIN_NPM_SCOPE,
  binaryPrefix: process.env.CODEGOBLIN_BINARY_PACKAGE_PREFIX || "codegoblin",
  command: "codegoblin",
  shortCommand: "cg",
  description: "Your local AI goblin for code, images, and agents.",
  repository: "https://github.com/shawnisikli/CodeGoblin",
}

function publishedPackageName() {
  return product.npmScope ? `${product.npmScope}/${product.npm}` : product.npm
}

async function published(name: string, version: string) {
  if (dryRun) return false
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  if (dryRun) {
    console.log(`[dry-run] would publish ${name}@${version}`)
    return
  }
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

async function copyDirectory(source: string, target: string) {
  await fs.promises.rm(target, { recursive: true, force: true })
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.cp(source, target, { recursive: true })
}

async function writeJSON(file: string, value: unknown) {
  await Bun.file(file).write(JSON.stringify(value, null, 2) + "\n")
}

function targetBinaryPackageName(name: string) {
  const prefix = `${pkg.name}-`
  if (name === pkg.name) return product.binaryPrefix
  if (name.startsWith(prefix)) return `${product.binaryPrefix}-${name.slice(prefix.length)}`
  throw new Error(`Unexpected native package name: ${name}`)
}

function nativeBinaryName(platform: string | undefined, command: string) {
  return platform === "win32" ? `${command}.exe` : command
}

async function createNativePackage(sourceName: string, version: string) {
  const targetName = targetBinaryPackageName(sourceName)
  const sourceDir = path.join(dir, "dist", sourceName)
  const targetDir = path.join(dir, "dist", targetName)
  if (path.resolve(sourceDir) !== path.resolve(targetDir)) {
    await copyDirectory(sourceDir, targetDir)
  }

  const packageJsonPath = path.join(targetDir, "package.json")
  const packageJson = await Bun.file(packageJsonPath).json()
  const sourceBinary = nativeBinaryName(packageJson.os?.[0], pkg.name)
  const targetBinary = nativeBinaryName(packageJson.os?.[0], product.command)
  const sourceBinaryPath = path.join(targetDir, "bin", sourceBinary)
  const targetBinaryPath = path.join(targetDir, "bin", targetBinary)

  if (sourceBinary !== targetBinary && fs.existsSync(sourceBinaryPath)) {
    await fs.promises.copyFile(sourceBinaryPath, targetBinaryPath)
    await fs.promises.chmod(targetBinaryPath, 0o755)
    await fs.promises.rm(sourceBinaryPath, { force: true })
  }

  await writeJSON(packageJsonPath, {
    ...packageJson,
    name: targetName,
    description: `${product.name} native CLI binary for ${packageJson.os?.join(", ") || "any OS"}/${
      packageJson.cpu?.join(", ") || "any CPU"
    }`,
    repository: {
      type: "git",
      url: product.repository,
    },
  })

  return [targetName, version] as const
}

function wrapper(command: string) {
  return `#!/usr/bin/env node
import childProcess from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const binDir = path.dirname(fileURLToPath(import.meta.url))
const native = path.join(binDir, "${product.command}.exe")

if (!fs.existsSync(native)) {
  console.error("Error: ${product.name}'s native binary was not installed.")
  console.error("")
  console.error("This can happen when installing with --ignore-scripts or with a package manager")
  console.error("that does not run postinstall scripts by default.")
  console.error("")
  console.error("To fix this, run:")
  console.error("  cd node_modules/${product.npm} && node postinstall.mjs")
  process.exit(1)
}

const child = childProcess.spawn(native, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    CODEGOBLIN: "1",
    CODEGOBLIN_CLI_NAME: "${command}",
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
`
}

function readme(version: string) {
  return `# ${product.name}

${product.description}

${product.name} is an independent fork/customization of OpenCode and is not affiliated with OpenCode, Anomaly, or their maintainers.

## Install

\`\`\`bash
npm install -g ${product.npm}@${version}
\`\`\`

Then run:

\`\`\`bash
${product.command} --help
${product.shortCommand} --help
\`\`\`

The npm package installs a small launcher plus the native ${product.name} binary package for your platform.
`
}

async function createInstallerPackage(nativePackages: Record<string, string>, version: string) {
  const packageName = publishedPackageName()
  const packageDir = path.join(dir, "dist", product.npm)
  await fs.promises.rm(packageDir, { recursive: true, force: true })
  await fs.promises.mkdir(path.join(packageDir, "bin"), { recursive: true })
  await fs.promises.copyFile(path.join(dir, "script", "postinstall.mjs"), path.join(packageDir, "postinstall.mjs"))
  await Bun.file(path.join(packageDir, "LICENSE")).write(await Bun.file(path.join(dir, "..", "..", "LICENSE")).text())
  await Bun.file(path.join(packageDir, "README.md")).write(readme(version))
  const commandWrapper = path.join(packageDir, "bin", `${product.command}.mjs`)
  const shortCommandWrapper = path.join(packageDir, "bin", `${product.shortCommand}.mjs`)
  await Bun.file(commandWrapper).write(wrapper(product.command))
  await Bun.file(shortCommandWrapper).write(wrapper(product.shortCommand))
  await fs.promises.chmod(commandWrapper, 0o755)
  await fs.promises.chmod(shortCommandWrapper, 0o755)

  await writeJSON(path.join(packageDir, "package.json"), {
    name: packageName,
    version,
    description: product.description,
    license: pkg.license,
    repository: {
      type: "git",
      url: product.repository,
    },
    homepage: product.repository,
    bugs: {
      url: `${product.repository}/issues`,
    },
    keywords: ["ai", "agent", "cli", "tui", "codegoblin", "local-first"],
    bin: {
      [product.command]: `./bin/${product.command}.mjs`,
      [product.shortCommand]: `./bin/${product.shortCommand}.mjs`,
    },
    files: ["bin", "postinstall.mjs", "README.md", "LICENSE"],
    scripts: {
      postinstall: "node ./postinstall.mjs",
    },
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
    optionalDependencies: nativePackages,
    nativeBinary: {
      product: product.name,
      command: product.command,
      sourceCommand: product.command,
      packagePrefix: product.binaryPrefix,
    },
  })
}

const sourceBinaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const packageJson = await Bun.file(`./dist/${filepath}`).json()
  if (packageJson.name.startsWith(`${pkg.name}-`)) sourceBinaries[packageJson.name] = packageJson.version
}

console.log("native sources", sourceBinaries)
const version = Object.values(sourceBinaries)[0] || Script.version
const nativePackages = Object.fromEntries(
  await Promise.all(Object.entries(sourceBinaries).map(([name, version]) => createNativePackage(name, version))),
)

console.log("native packages", nativePackages)
await createInstallerPackage(nativePackages, version)

await Promise.all(Object.entries(nativePackages).map(([name, version]) => publish(`./dist/${name}`, name, version)))
await publish(`./dist/${product.npm}`, publishedPackageName(), version)
