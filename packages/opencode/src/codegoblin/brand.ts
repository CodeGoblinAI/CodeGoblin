export const CodeGoblinBrand = {
  product: "CodeGoblin",
  cli: "codegoblin",
  shortCli: "cg",
  tagline: "Your local AI goblin for code, images, and agents.",
  disclaimer:
    "CodeGoblin is an independent fork/customization of OpenCode and is not affiliated with OpenCode, Anomaly, or their maintainers.",
  docs: "docs/PROJECT_STATE.md",
} as const

export function codeGoblinCliName() {
  const raw = process.env.CODEGOBLIN_CLI_NAME?.trim()
  if (raw === CodeGoblinBrand.shortCli) return CodeGoblinBrand.shortCli
  return CodeGoblinBrand.cli
}

export function codeGoblinEnabled() {
  return process.env.CODEGOBLIN !== "0"
}
