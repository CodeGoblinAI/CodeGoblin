import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@codegoblin/core/effect/service-use"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@codegoblin/core/process"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import * as Log from "@codegoblin/core/util/log"
import { makeRuntime } from "@codegoblin/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@codegoblin/core/installation/version"
import { NpmConfig } from "@codegoblin/core/npm-config"
import { Product, npmInstallSpec, npmRegistryPackageUrl } from "./product"
import { needsWindowsUpdateHandoff, scheduleWindowsUpdate } from "./windows-update"

const log = Log.create({ service: "installation" })

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: BusEvent.define(
    "installation.updated",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
  UpdateAvailable: BusEvent.define(
    "installation.update-available",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `${Product.cliName}/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const NpmPackage = Schema.Struct({ version: Schema.String })
const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
const BrewInfoV2 = Schema.Struct({
  formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
})
const ChocoPackage = Schema.Struct({
  d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
})
const ScoopManifest = NpmPackage

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@codegoblin/Installation") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const getBrewFormula = Effect.fnUntraced(function* () {
      for (const formula of Product.brewFormulae) {
        const listed = yield* text(["brew", "list", "--formula", formula])
        const name = formula.includes("/") ? formula.split("/").pop()! : formula
        if (listed.includes(name)) return formula
      }
      return Product.brewFormulae[0]
    })

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        if (process.platform !== "win32" && Product.installScriptUrl) {
          const piped = yield* Effect.gen(function* () {
            const response = yield* httpOk.execute(HttpClientRequest.get(Product.installScriptUrl))
            const body = yield* response.text
            const bodyBytes = new TextEncoder().encode(body)
            return yield* appProcess.run(
              ChildProcess.make("bash", [], {
                stdin: Stream.make(bodyBytes),
                env: { VERSION: target, CODEGOBLIN_NPM_PACKAGE: Product.npmScopedPackage },
                extendEnv: true,
              }),
            )
          }).pipe(
            Effect.map((result) => ({
              code: result.exitCode,
              stdout: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            })),
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (piped) return piped
        }
        return yield* run(["npm", "install", "-g", npmInstallSpec(target)])
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })),
    )

    // The install method can't change while the process runs, and detecting it
    // shells out to package managers — cache the first successful detection.
    let cachedMethod: Method | undefined

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (cachedMethod) return cachedMethod
        if (process.execPath.includes(path.join(".codegoblin", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string>; packages: string[] }> = [
          {
            name: "npm",
            command: () => text(["npm", "list", "-g", "--depth=0"]),
            packages: [Product.npmScopedPackage, Product.npmPackage, Product.legacyNpmPackage],
          },
          {
            name: "yarn",
            command: () => text(["yarn", "global", "list"]),
            packages: [Product.npmScopedPackage, Product.npmPackage, Product.legacyNpmPackage],
          },
          {
            name: "pnpm",
            command: () => text(["pnpm", "list", "-g", "--depth=0"]),
            packages: [Product.npmScopedPackage, Product.npmPackage, Product.legacyNpmPackage],
          },
          {
            name: "bun",
            command: () => text(["bun", "pm", "ls", "-g"]),
            packages: [Product.npmScopedPackage, Product.npmPackage, Product.legacyNpmPackage],
          },
          {
            name: "brew",
            command: () => text(["brew", "list", "--formula", Product.brewFormulae[0]]),
            packages: Product.brewFormulae.map((formula) =>
              formula.includes("/") ? formula.split("/").pop()! : formula,
            ),
          },
          {
            name: "scoop",
            command: () => text(["scoop", "list", Product.scoopPackage]),
            packages: [Product.scoopPackage, Product.legacyScoopPackage],
          },
          {
            name: "choco",
            command: () => text(["choco", "list", "--limit-output", Product.chocoPackage]),
            packages: [Product.chocoPackage, Product.legacyChocoPackage],
          },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        // Probe every package manager concurrently with a hard per-probe timeout.
        // Sequential probing summed to minutes on Windows, where a single
        // `npm list -g` can take tens of seconds — the update check looked hung.
        const outputs = yield* Effect.all(
          checks.map((check) =>
            check.command().pipe(
              Effect.timeout("10 seconds"),
              Effect.catch(() => Effect.succeed("")),
              Effect.map((output) => ({ check, output })),
            ),
          ),
          { concurrency: checks.length },
        )
        for (const { check, output } of outputs) {
          if (check.packages.some((pkg) => output.includes(pkg))) {
            cachedMethod = check.name
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* result.method())

        if (detectedMethod === "brew") {
          const formula = yield* getBrewFormula()
          if (formula.includes("/")) {
            const infoJson = yield* text(["brew", "info", "--json=v2", formula])
            const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
            return info.formulae[0].versions.stable
          }
          const formulaName = formula.includes("/") ? formula.split("/").pop()! : formula
          const response = yield* httpOk.execute(
            HttpClientRequest.get(`https://formulae.brew.sh/api/formula/${encodeURIComponent(formulaName)}.json`).pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(BrewFormula)(response)
          return data.versions.stable
        }

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const registry = yield* NpmConfig.registry(process.cwd())
          const response = yield* httpOk.execute(
            HttpClientRequest.get(npmRegistryPackageUrl(registry, InstallationChannel)).pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        if (detectedMethod === "choco") {
          for (const pkg of [Product.chocoPackage, Product.legacyChocoPackage]) {
            const response = yield* httpOk
              .execute(
                HttpClientRequest.get(
                  `https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27${encodeURIComponent(pkg)}%27%20and%20IsLatestVersion&$select=Version`,
                ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
              )
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!response) continue
            const data = yield* HttpClientResponse.schemaBodyJson(ChocoPackage)(response).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            const version = data?.d.results[0]?.Version
            if (version) return version
          }
        }

        if (detectedMethod === "scoop") {
          for (const pkg of [Product.scoopPackage, Product.legacyScoopPackage]) {
            const response = yield* httpOk
              .execute(
                HttpClientRequest.get(
                  `https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/${pkg}.json`,
                ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
              )
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!response || response.status === 404) continue
            const data = yield* HttpClientResponse.schemaBodyJson(ScoopManifest)(response).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (data?.version) return data.version
          }
        }

        const response = yield* httpOk.execute(
          HttpClientRequest.get(Product.githubReleaseApi()).pipe(HttpClientRequest.acceptJson),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        if (needsWindowsUpdateHandoff({ method: m })) {
          return yield* Effect.tryPromise({
            try: () => scheduleWindowsUpdate({ method: m, target }),
            catch: () =>
              new UpgradeFailedError({ stderr: "Could not prepare the Windows update helper. Please try again." }),
          })
        }
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            upgradeResult = yield* upgradeCurl(target)
            break
          case "npm":
            upgradeResult = yield* run(["npm", "install", "-g", npmInstallSpec(target)])
            break
          case "pnpm":
            upgradeResult = yield* run(["pnpm", "install", "-g", npmInstallSpec(target)])
            break
          case "yarn":
            upgradeResult = yield* run(["yarn", "global", "add", npmInstallSpec(target)])
            break
          case "bun":
            upgradeResult = yield* run(["bun", "install", "-g", npmInstallSpec(target)])
            break
          case "brew": {
            const formula = yield* getBrewFormula()
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            if (formula.includes("/")) {
              const tap = yield* run(["brew", "tap", "anomalyco/tap"], { env })
              if (tap.code !== 0) {
                upgradeResult = tap
                break
              }
              const repo = yield* text(["brew", "--repo", "anomalyco/tap"])
              const dir = repo.trim()
              if (dir) {
                const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
                if (pull.code !== 0) {
                  upgradeResult = pull
                  break
                }
              }
            }
            upgradeResult = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          case "choco":
            upgradeResult = yield* run(["choco", "upgrade", Product.chocoPackage, `--version=${target}`, "-y"])
            if (upgradeResult.code !== 0) {
              upgradeResult = yield* run(["choco", "upgrade", Product.legacyChocoPackage, `--version=${target}`, "-y"])
            }
            break
          case "scoop":
            upgradeResult = yield* run(["scoop", "install", `${Product.scoopPackage}@${target}`])
            if (upgradeResult.code !== 0) {
              upgradeResult = yield* run(["scoop", "install", `${Product.legacyScoopPackage}@${target}`])
            }
            break
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
        }
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
        }
        log.info("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(AppProcess.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
