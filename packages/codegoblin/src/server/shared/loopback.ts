const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"])

function parseHost(host: string): string {
  const bare = host.trim().split(",")[0]?.trim() ?? ""
  if (bare.startsWith("[")) {
    const end = bare.indexOf("]")
    return end > 0 ? bare.slice(1, end).toLowerCase() : bare.toLowerCase()
  }
  if (/^\d+\.\d+\.\d+\.\d+:/.test(bare)) return bare.split(":")[0]!.toLowerCase()
  if (bare.includes(":") && !bare.includes("::")) return bare.split(":")[0]!.toLowerCase()
  return bare.toLowerCase()
}

/** True when `host` is a loopback name (strips port and IPv6 brackets). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host?.trim()) return true
  return LOOPBACK.has(parseHost(host))
}

type HeaderBag = Record<string, string | string[] | undefined>

function headerValue(headers: HeaderBag, key: string): string | undefined {
  const value = headers[key] ?? headers[key.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Best-effort check that an HTTP request targets the local server from a loopback client.
 * Used to gate host-only actions (native folder picker, Firebase login terminal).
 */
export function isHostOnlyHttpRequest(headers: HeaderBag): boolean {
  if (!isLoopbackHost(headerValue(headers, "host"))) return false
  const forwarded = headerValue(headers, "x-forwarded-for")
  if (!forwarded) return true
  const client = forwarded.split(",")[0]?.trim() ?? ""
  const clientHost = client.split(":")[0]
  return isLoopbackHost(clientHost)
}
