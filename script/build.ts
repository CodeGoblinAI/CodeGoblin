#!/usr/bin/env bun
/**
 * Builds CodeGoblin into one program per platform: `dist/codegoblin-<os>-<arch>/bin/codegoblin[.exe]`, each
 * with the package.json its npm package is published with. Nobody who installs it needs Bun.
 *
 *   bun script/build.ts                  this machine's platform
 *   bun script/build.ts --all            every platform (Bun cross-compiles)
 *   bun script/build.ts --target linux-x64
 *   bun script/build.ts --version 0.4.0  the version to stamp (default: package.json's)
 *   bun script/build.ts --no-catalog     do not fetch the model catalogue to carry (offline builds)
 *
 * It also writes `dist/codegoblin/`, the small package people install by name (@codegoblin-io/codegoblin):
 * the launcher (npm/launcher.mjs) and a list of the per-platform packages, of which npm installs the one that
 * fits. It has no install script - nothing runs on someone's computer until they start CodeGoblin.
 *
 * What the build puts inside the program, beyond the code: the web app's files (src/web/assets.ts), the
 * version, and the model catalogue as it is today, so a first run with no connection still lists providers.
 */
import fs from "node:fs"
import path from "node:path"
import pkg from "../package.json"
import { usableCatalog, builtInPrices, builtInVision } from "../src/core/catalog"

const root = path.resolve(import.meta.dir, "..")
const argv = process.argv.slice(2)
const flag = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }

/** npm's names for a platform (os/cpu in package.json), the folder name the installer looks for, and Bun's target. */
const TARGETS = [
  { name: "windows-x64", os: "win32", cpu: "x64", bun: "bun-windows-x64" },
  { name: "windows-arm64", os: "win32", cpu: "arm64", bun: "bun-windows-arm64" },
  { name: "linux-x64", os: "linux", cpu: "x64", bun: "bun-linux-x64" },
  { name: "linux-arm64", os: "linux", cpu: "arm64", bun: "bun-linux-arm64" },
  { name: "darwin-arm64", os: "darwin", cpu: "arm64", bun: "bun-darwin-arm64" },
] as const

const here = TARGETS.find((target) => target.os === process.platform && target.cpu === process.arch)
const wanted = argv.includes("--all") ? [...TARGETS]
  : flag("--target") ? TARGETS.filter((target) => target.name === flag("--target"))
  : here ? [here] : []
if (!wanted.length) { console.error("no such target. Known: " + TARGETS.map((target) => target.name).join(", ")); process.exit(1) }

const version = flag("--version") || process.env.CODEGOBLIN_VERSION || pkg.version
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) { console.error("not a version: " + version); process.exit(1) }

/** The catalogue in the trimmed shape the app caches it in, or the empty one when it cannot be fetched. */
async function catalogue(): Promise<string> {
  const empty = JSON.stringify({ at: 0, providers: [] })
  if (argv.includes("--no-catalog")) return empty
  try {
    const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(30_000), redirect: "error" })
    if (!response.ok) throw new Error("models.dev answered " + response.status)
    const raw = await response.json()
    const providers = usableCatalog(raw)
    if (!providers.length) throw new Error("models.dev listed nothing usable")
    console.log(`catalogue: ${providers.length} providers, ${providers.reduce((sum, provider) => sum + provider.models.length, 0)} models`)
    // `at` 0: carried data is always treated as stale, so a run with a connection refreshes it.
    return JSON.stringify({ at: 0, providers, prices: builtInPrices(raw), vision: builtInVision(raw) })
  } catch (error) {
    if (argv.includes("--require-catalog")) { console.error("catalogue: " + (error instanceof Error ? error.message : String(error))); process.exit(1) }
    console.warn("catalogue: not carried (" + (error instanceof Error ? error.message : String(error)) + ") - a first run will need a connection to list providers")
    return empty
  }
}
const carried = await catalogue()
const REPOSITORY = { type: "git", url: "git+https://github.com/CodeGoblinAI/CodeGoblin.git" }

for (const target of wanted) {
  const folder = path.join(root, "dist", "codegoblin-" + target.name)
  const outfile = path.join(folder, "bin", target.os === "win32" ? "codegoblin.exe" : "codegoblin")
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  const started = Date.now()
  const result = await Bun.build({
    entrypoints: [path.join(root, "src", "cli", "main.ts")],
    compile: { target: target.bun, outfile },
    minify: { whitespace: true, syntax: true },
    define: {
      "process.env.CODEGOBLIN_VERSION": JSON.stringify(version),
      "process.env.CODEGOBLIN_COMPILED": JSON.stringify("1"),
    },
    plugins: [{
      name: "carried-catalogue",
      setup(build) {
        build.onLoad({ filter: /[\\/]catalog-snapshot\.json$/ }, () => ({ contents: carried, loader: "json" }))
      },
    }],
  } as Parameters<typeof Bun.build>[0])
  if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1) }
  fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({
    name: "codegoblin-" + target.name,
    version,
    description: `CodeGoblin for ${target.os}/${target.cpu}`,
    license: pkg.license,
    repository: REPOSITORY,
    os: [target.os],
    cpu: [target.cpu],
  }, null, 2) + "\n")
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(folder, "LICENSE"))
  console.log(`built codegoblin-${target.name} ${version}: ${(fs.statSync(outfile).size / 1e6).toFixed(0)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

// The package installed by name. Always lists every platform, whichever ones this run built: it is the same
// package for everyone, and publishing checks that all five exist.
{
  const folder = path.join(root, "dist", "codegoblin")
  fs.mkdirSync(path.join(folder, "bin"), { recursive: true })
  fs.copyFileSync(path.join(root, "npm", "launcher.mjs"), path.join(folder, "bin", "codegoblin.mjs"))
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(folder, "LICENSE"))
  fs.writeFileSync(path.join(folder, "README.md"), [
    "# CodeGoblin",
    "",
    pkg.description,
    "",
    "```",
    "npm install -g @codegoblin-io/codegoblin",
    "codegoblin",
    "```",
    "",
    "`codegoblin web` starts the web app, `codegoblin upgrade` updates it, and `codegoblin --help` lists the rest.",
    "",
    "This package is a small launcher. npm installs the CodeGoblin program for your computer beside it: Windows, Linux and macOS (Apple chips), x64 and arm64. Needs Node 18 or later to start; nothing else.",
    "",
    "https://github.com/CodeGoblinAI/CodeGoblin",
    "",
  ].join("\n"))
  fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({
    name: "@codegoblin-io/codegoblin",
    version,
    description: pkg.description,
    license: pkg.license,
    repository: REPOSITORY,
    homepage: "https://github.com/CodeGoblinAI/CodeGoblin",
    bugs: { url: "https://github.com/CodeGoblinAI/CodeGoblin/issues" },
    keywords: ["ai", "agent", "cli", "tui", "codegoblin", "local-first"],
    type: "module",
    bin: { codegoblin: "bin/codegoblin.mjs", cg: "bin/codegoblin.mjs" },
    files: ["bin", "README.md", "LICENSE"],
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(TARGETS.map((target) => ["codegoblin-" + target.name, version])),
  }, null, 2) + "\n")
  console.log(`wrote the installer package @codegoblin-io/codegoblin ${version}`)
}
