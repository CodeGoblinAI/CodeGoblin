/**
 * Files that hold secrets, recognised by name.
 *
 * Reading one asks first in every mode, full access included: full access is
 * for getting work done without interruptions, not for handing the model the
 * user's keys. A real run started in the home folder printed the key store with
 * `type auth.json` and sent every stored key to the provider. The fork asks
 * before `*.env` reads for the same reason.
 *
 * This matches names, so a script that builds a path at runtime gets past it.
 * Scrubbing stored keys from tool output (`redactSecrets`) still covers the
 * known keys; a sandbox is what would close it properly.
 */
const BACKSLASH = String.fromCharCode(92)

const NAMES = new Set([
  ".env", "auth.json", "credentials", "credentials.json", ".netrc", "_netrc", ".npmrc", ".pypirc",
  ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".pgpass", "secrets.json",
])
const EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]
const FOLDERS = new Set([".ssh", ".aws", ".gnupg", ".azure"])
/** Templates that hold no values, which projects commit on purpose. */
const TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i

/**
 * A path's parts as Windows reads them. `.env::$DATA` names the file's own contents (an NTFS stream), and
 * `.env.` or `.env ` open `.env` itself in cmd.exe, which drops a name's trailing dots and spaces. Each was a
 * way to read a secret file without its name matching.
 */
function partsOf(target: string): string[] {
  return target.split(BACKSLASH).join("/").split("/").filter(Boolean).map((part, index) => {
    const lower = part.toLowerCase()
    if (index === 0 && /^[a-z]:$/.test(lower)) return lower
    return lower.replace(/:.*$/, "").replace(/[. ]+$/, "")
  }).filter(Boolean)
}

export function isSecretPath(target: string): boolean {
  const parts = partsOf(target)
  const name = parts.at(-1)
  if (!name) return false
  if (TEMPLATE.test(name)) return false
  if (parts.slice(0, -1).some((part) => FOLDERS.has(part)) && !name.endsWith(".pub") && name !== "known_hosts") return true
  if (NAMES.has(name)) return true
  if (name.startsWith(".env.")) return true
  if (parts.at(-2) === ".docker" && name === "config.json") return true
  return EXTENSIONS.some((extension) => name.endsWith(extension))
}

/**
 * The secret files a shell command names. Words are split on spaces, quotes,
 * redirects and separators, so `type "C:\x\auth.json"`, `cat .env|more` and
 * `copy .env x` are all caught.
 */
export function secretPathsIn(command: string): string[] {
  const words = command.split(/[\s"'`|&;<>()=,]+/).filter(Boolean)
  return [...new Set(words.filter((word) => !/^[a-z]+:\/\//i.test(word) && isSecretPath(word)))]
}

/** The path a file tool's JSON arguments name, if it names one. */
export function pathArgument(detail: string): string | undefined {
  try {
    const parsed = JSON.parse(detail) as { path?: unknown } | null
    return parsed && typeof parsed.path === "string" ? parsed.path : undefined
  } catch {
    return undefined
  }
}
