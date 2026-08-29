import dns from "node:dns/promises"

/**
 * Fetching a page.
 *
 * The model reads files, and files contain text someone else wrote. A tool
 * that turns text into an outbound request is the shortest path from "read
 * this README" to "send what you know to my server", so this one is built to
 * be suspicious:
 *
 * - it asks permission, because the URL is worth a human glance;
 * - it refuses anything that is not http or https;
 * - it resolves the host and refuses private, loopback and link-local
 *   addresses, which is what actually stops it - blocking literal 127.0.0.1
 *   is theatre when localtest.me resolves there too;
 * - it follows redirects by hand, checking each hop, because a public URL
 *   that redirects into the private network is the same attack wearing a hat;
 * - it gives up on time and on size rather than reading forever.
 */

const MAX_BYTES = 400_000
const MAX_TEXT = 24_000
const MAX_HOPS = 5
const TIMEOUT_MS = 15_000
const NEWLINE = String.fromCharCode(10)

/** Ranges no page worth reading lives in, including cloud metadata at 169.254.169.254. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase()

  if (ip.includes(":")) {
    // ::ffff:127.0.0.1 is a v4 address wearing v6 clothes.
    const mapped = ip.split(":").pop() ?? ""
    if (mapped.includes(".")) return isPrivateAddress(mapped)
    if (ip === "::1" || ip === "::") return true
    // Unique local (fc00::/7) and link-local (fe80::/10).
    return ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe8") || ip.startsWith("fe9") ||
      ip.startsWith("fea") || ip.startsWith("feb")
  }

  const parts = ip.split(".")
  if (parts.length !== 4) return true
  const octets = parts.map((part) => Number(part))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true

  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

/**
 * The network, injectable.
 *
 * Not for neatness: the interesting attack here is a public URL that
 * redirects into the private network, and that is untestable against the
 * real internet because it needs a host that behaves badly on demand.
 */
export type Network = {
  /** Only the call shape this module uses, so a test can supply a plain function. */
  fetch: (url: URL, init: RequestInit) => Promise<Response>
  resolve: (hostname: string) => Promise<string[]>
}

const realNetwork: Network = {
  fetch: (url, init) => fetch(url, init),
  resolve: async (hostname) => (await dns.lookup(hostname, { all: true })).map((entry) => entry.address),
}

/** Refuse before connecting, so a blocked host is never even contacted. */
async function assertPublic(hostname: string, network: Network) {
  let addresses: string[]
  try {
    addresses = await network.resolve(hostname)
  } catch {
    throw new Error(`cannot resolve ${hostname}`)
  }
  if (!addresses.length) throw new Error(`cannot resolve ${hostname}`)
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`refusing to fetch ${hostname}: it resolves to the private address ${address}`)
    }
  }
}

function assertFetchable(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing to fetch ${url.protocol}// - only http and https`)
  }
}

/** Tags out, entities in, whitespace collapsed. Enough to read; not a browser. */
export function htmlToText(html: string): string {
  const withoutHead = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")

  // Source newlines are whitespace in HTML, not line breaks. Flattening first
  // means a paragraph hard-wrapped at eighty columns comes back as one line
  // instead of eight ragged ones, and only real block tags start a new line.
  const spaced = withoutHead
    .replace(/\s+/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, NEWLINE)
    .replace(/<br\s*\/?>/gi, NEWLINE)
    .replace(/<[^>]+>/g, " ")

  const entities: Record<string, string> = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
  }
  const decoded = spaced.replace(/&[a-z#0-9]+;/gi, (match) => entities[match.toLowerCase()] ?? match)

  return decoded
    .split(NEWLINE)
    .map((line) => line.replace(/ +/g, " ").trim())
    .filter((line) => line.length > 0)
    .join(NEWLINE)
}

/** Read at most MAX_BYTES, so a stream that never ends does not hang the turn. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  await reader.cancel().catch(() => {})
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    const room = Math.min(chunk.length, total - offset)
    joined.set(chunk.subarray(0, room), offset)
    offset += room
  }
  return new TextDecoder("utf-8").decode(joined)
}

export async function fetchUrl(raw: string, network: Network = realNetwork): Promise<string> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a URL: ${raw}`)
  }

  const visited: string[] = []
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    assertFetchable(url)
    await assertPublic(url.hostname, network)
    visited.push(url.toString())

    const response = await network.fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
    })

    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url)
      continue
    }

    if (!response.ok) throw new Error(`${url.hostname} returned ${response.status}`)

    const type = (response.headers.get("content-type") ?? "").toLowerCase()
    const readable = type.includes("html") || type.includes("text") || type.includes("json") ||
      type.includes("xml") || type === ""
    if (!readable) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`nothing readable at ${url.hostname}: content type is ${type}`)
    }

    const body = await readCapped(response)
    const text = type.includes("html") ? htmlToText(body) : body.trim()
    const trail = visited.length > 1 ? `(redirected via ${visited.length - 1} hop${visited.length > 2 ? "s" : ""})` : ""
    const header = [url.toString(), trail].filter(Boolean).join(" ")

    return text.length > MAX_TEXT
      ? header + NEWLINE + NEWLINE + text.slice(0, MAX_TEXT) + NEWLINE + `… truncated at ${MAX_TEXT} characters`
      : header + NEWLINE + NEWLINE + text
  }

  throw new Error(`too many redirects starting at ${visited[0]}`)
}
