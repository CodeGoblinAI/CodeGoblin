function env(suffix: string) {
  return process.env["CODEGOBLIN_" + suffix] ?? process.env["OPENCODE_" + suffix]
}

function envOr(suffix: string, fallback: string) {
  return env(suffix) || fallback
}

/** CodeGoblin distribution identity — used for updates, npm install, and release checks. */
export const Product = {
  name: "CodeGoblin",
  cliName: envOr("CLI_NAME", "codegoblin"),
  npmPackage: envOr("NPM_PACKAGE", "codegoblin"),
  /** Legacy npm package name kept for install-method detection on migrated machines. */
  legacyNpmPackage: "opencode-ai",
  githubRepo: envOr("GITHUB_REPO", "shawnisikli/CodeGoblin"),
  githubReleaseApi: () => `https://api.github.com/repos/${Product.githubRepo}/releases/latest`,
  /** Optional install script URL; curl installs fall back to npm when unset. */
  installScriptUrl: env("INSTALL_SCRIPT_URL"),
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
  return `${registry.replace(/\/$/, "")}/${Product.npmPackage}/${tag}`
}

export function npmInstallSpec(version: string) {
  return `${Product.npmPackage}@${version}`
}

export function legacyNpmInstallSpec(version: string) {
  return `${Product.legacyNpmPackage}@${version}`
}

export function userAgent(client = "cli") {
  return `${Product.cliName}/${client}`
}
