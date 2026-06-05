/** Relative path for CodeGoblin media API query params (never absolute Windows paths). */
export function relativeCodeGoblinOutput(directory: string, output: string | undefined) {
  if (!output?.trim()) return
  const trimmed = output.trim()
  if (!/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.startsWith("\\\\") && !trimmed.startsWith("/")) {
    return trimmed.replace(/\\/g, "/")
  }

  const root = directory.replace(/[\\/]+$/, "").replace(/\\/g, "/")
  const normalized = trimmed.replace(/\\/g, "/")
  const rootLower = root.toLowerCase()
  const outLower = normalized.toLowerCase()
  if (outLower.startsWith(`${rootLower}/`)) {
    return normalized.slice(root.length + 1)
  }
  return trimmed
}

export function displayCodeGoblinOutput(directory: string, output: string | undefined) {
  if (!output?.trim()) return
  const trimmed = output.trim()
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\") || trimmed.startsWith("/")) return trimmed
  const root = directory.replace(/[\\/]+$/, "")
  if (/^[A-Za-z]:[\\/]/.test(root) || root.includes("\\")) return `${root}\\${trimmed.replace(/\//g, "\\")}`
  return `${root}/${trimmed.replace(/\\/g, "/")}`
}

export function isGlbOutputPath(output?: string) {
  if (!output) return false
  return /\.glb($|[?#])/i.test(output)
}
