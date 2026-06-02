function env(suffix: string) {
  return process.env["CODEGOBLIN_" + suffix] ?? process.env["OPENCODE_" + suffix]
}

function envOr(suffix: string, fallback: string) {
  return env(suffix) || fallback
}

const githubRepo = envOr("GITHUB_REPO", "shawnisikli/CodeGoblin")
const npmPackage = envOr("NPM_PACKAGE", "codegoblin")
const npmScope = env("NPM_SCOPE")

/** CodeGoblin distribution identity — used for updates, npm install, and release checks. */
export const Product = {
  name: "CodeGoblin",
  cliName: envOr("CLI_NAME", "codegoblin"),
  /** Unscoped package today (`codegoblin`). Future org scope via CODEGOBLIN_NPM_SCOPE, e.g. `@codegoblin/cli`. */
  npmPackage,
  npmScope,
  npmScopedPackage: npmScope ? `${npmScope}/${npmPackage}` : npmPackage,
  /** Legacy npm package name kept for install-method detection on migrated machines. */
  legacyNpmPackage: "opencode-ai",
  githubRepo,
  githubReleaseApi: () => `https://api.github.com/repos/${githubRepo}/releases/latest`,
  installScriptUrl:
    env("INSTALL_SCRIPT_URL") ||
    `https://raw.githubusercontent.com/${githubRepo}/dev/script/install.sh`,
  installScriptUrlWindows:
    env("INSTALL_SCRIPT_URL_WINDOWS") ||
    `https://raw.githubusercontent.com/${githubRepo}/dev/script/install.ps1`,
  /** Default remote models catalog base (append /api.json). Override with CODEGOBLIN_MODELS_URL. */
  modelsCatalogUrl: envOr("MODELS_CATALOG_URL", "https://raw.githubusercontent.com/shawnisikli/CodeGoblin/dev/packages/codegoblin/models"),
  brewFormulae: [envOr("BREW_FORMULA", "codegoblin"), "anomalyco/tap/opencode", "opencode"],
  scoopPackage: envOr("SCOOP_PACKAGE", "codegoblin"),
  legacyScoopPackage: "opencode",
  chocoPackage: envOr("CHOCO_PACKAGE", "codegoblin"),
  legacyChocoPackage: "opencode",
} as const

export function npmRegistryPackageUrl(registry: string, channel: string) {
  const tag = channel || "latest"
  const pkg = encodeURIComponent(Product.npmScopedPackage)
  return `${registry.replace(/\/$/, "")}/${pkg}/${tag}`
}

export function npmInstallSpec(version: string) {
  return `${Product.npmScopedPackage}@${version}`
}

export function legacyNpmInstallSpec(version: string) {
  return `${Product.legacyNpmPackage}@${version}`
}

export function userAgent(client = "cli") {
  return `${Product.cliName}/${client}`
}
