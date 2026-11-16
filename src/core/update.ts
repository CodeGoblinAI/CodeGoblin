import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import { InstallationVersion } from "../platform/version"
import { loadConfig } from "./config"

/**
 * Whether a newer CodeGoblin has been published.
 *
 * The app only ever says so. It does not install anything by itself: a
 * program that can run commands on this computer should change when its
 * owner asks, and `codegoblin upgrade` is that ask.
 *
 * The check is one small request to the npm registry for the package's
 * published versions, at most once a day, started after the app is up and
 * never waited for. It sends nothing about the person or their work. It does
 * not run from a source checkout, and CODEGOBLIN_DISABLE_AUTOUPDATE=1 or
 * `"autoupdate": false` in codegoblin.jsonc (the switch 0.3 already had)
 * turns it off.
 */
export const PACKAGE = "@codegoblin-io/codegoblin"
const REGISTRY = () => process.env.CODEGOBLIN_REGISTRY_URL || "https://registry.npmjs.org"
const DAY = 24 * 60 * 60 * 1000
const file = () => path.join(Global.Path.state, "update.json")

type Parsed = { main: [number, number, number]; pre: string[] }

function parse(version: string): Parsed | undefined {
  const found = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim())
  if (!found) return undefined
  return { main: [Number(found[1]), Number(found[2]), Number(found[3])], pre: found[4] ? found[4].split(".") : [] }
}

/** Is `candidate` a later version than `current`? Semver order: 0.4.0-next.2 < 0.4.0 < 0.4.1. Anything unreadable is never newer. */
export function newer(candidate: string, current: string): boolean {
  const a = parse(candidate), b = parse(current)
  if (!a || !b) return false
  for (let index = 0; index < 3; index++) if (a.main[index] !== b.main[index]) return a.main[index]! > b.main[index]!
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index], y = b.pre[index]
    if (x === undefined || y === undefined) return y === undefined
    if (x === y) continue
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) > Number(y)
    if (nx !== ny) return ny
    return x > y
  }
  return false
}

/**
 * The version to offer someone on `current`, from the registry's tags.
 *
 * A released version is only ever offered `latest`. A preview (0.4.0-next.1)
 * is also offered a later preview, since that is the line its owner chose.
 */
export function offered(current: string, tags: Record<string, unknown>): string | undefined {
  const preview = Boolean(parse(current)?.pre.length)
  const candidates = [tags.latest, ...(preview ? [tags.next] : [])].filter((tag): tag is string => typeof tag === "string" && newer(tag, current))
  return candidates.sort((a, b) => (newer(a, b) ? -1 : 1))[0]
}

export async function publishedTags(fetcher: typeof fetch = fetch, timeoutMs = 4000): Promise<Record<string, unknown>> {
  // The short form of the package record: versions and tags, without every README.
  const response = await fetcher(`${REGISTRY()}/${PACKAGE.replace("/", "%2f")}`, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error("registry answered " + response.status)
  const body = await response.json() as { "dist-tags"?: unknown }
  return body["dist-tags"] && typeof body["dist-tags"] === "object" ? body["dist-tags"] as Record<string, unknown> : {}
}

export function checksAllowed(env: NodeJS.ProcessEnv = process.env, version = InstallationVersion, config?: { autoupdate?: unknown }): boolean {
  if (version.endsWith("-dev")) return false
  if (env.CODEGOBLIN_DISABLE_AUTOUPDATE && env.CODEGOBLIN_DISABLE_AUTOUPDATE !== "0" && env.CODEGOBLIN_DISABLE_AUTOUPDATE !== "false") return false
  return config?.autoupdate !== false
}

type Saved = { checkedAt: number; tags: Record<string, unknown> }

/**
 * The newer version, if there is one - asking the registry at most once a
 * day and otherwise answering from what it said last time. Never throws: no
 * network, a slow registry or a damaged file all mean "nothing to say".
 */
export async function availableUpdate(options: { current?: string; now?: number; fetcher?: typeof fetch; allowed?: boolean } = {}): Promise<string | undefined> {
  const current = options.current ?? InstallationVersion
  if (!(options.allowed ?? checksAllowed(process.env, current, loadConfig()))) return undefined
  const now = options.now ?? Date.now()
  let saved: Saved | undefined
  try {
    const read = JSON.parse(await fs.readFile(file(), "utf8")) as Saved
    if (typeof read.checkedAt === "number" && read.tags && typeof read.tags === "object") saved = read
  } catch {}
  if (!saved || now - saved.checkedAt > DAY || now < saved.checkedAt) {
    try {
      saved = { checkedAt: now, tags: await publishedTags(options.fetcher) }
      await fs.mkdir(Global.Path.state, { recursive: true })
      await fs.writeFile(file(), JSON.stringify(saved), "utf8")
    } catch {
      // Keep what was known; try again next start.
    }
  }
  return saved ? offered(current, saved.tags) : undefined
}

/** The one line shown when there is something newer. */
export const updateLine = (version: string) => `CodeGoblin ${version} is out - run \`codegoblin upgrade\` when you want it`
