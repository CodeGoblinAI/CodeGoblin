import dns from "node:dns/promises"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import zlib from "node:zlib"

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
 * - it resolves the host, refuses private, loopback and link-local addresses,
 *   and connects to the exact address it just checked (so a host whose DNS
 *   answer flips to 127.0.0.1 on the second lookup never reaches localhost);
 * - it follows redirects by hand, checking each hop, because a public URL
 *   that redirects into the private network is the same attack wearing a hat;
 * - it caps both wire bytes and decompressed bytes rather than reading forever.
 */

const MAX_BYTES = 400_000
const MAX_TEXT = 24_000
const MAX_HOPS = 5
const TIMEOUT_MS = 15_000
const NEWLINE = String.fromCharCode(10)

function parseIpv4Octets(text: string): [number, number, number, number] | undefined {
  const parts = text.split(".")
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined
    const n = Number(part)
    if (n < 0 || n > 255) return undefined
    octets.push(n)
  }
  return octets as [number, number, number, number]
}

/** The eight 16-bit groups of an IPv6 address (with or without a dotted v4 tail), or nothing when invalid. */
function expandV6(ip: string): number[] | undefined {
  let clean = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "")
  const lastColon = clean.lastIndexOf(":")
  if (lastColon >= 0 && clean.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4Octets(clean.slice(lastColon + 1))
    if (!v4) return undefined
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    clean = clean.slice(0, lastColon + 1) + hi + ":" + lo
  }
  const [head = "", tail, extra] = clean.split("::")
  if (extra !== undefined) return undefined
  const parse = (text: string) => (text ? text.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)) : [])
  const front = parse(head), back = tail === undefined ? [] : parse(tail)
  if ([...front, ...back].some(Number.isNaN)) return undefined
  if (tail === undefined) return front.length === 8 ? front : undefined
  if (front.length + back.length > 7) return undefined
  return [...front, ...Array.from({ length: 8 - front.length - back.length }, () => 0), ...back]
}

/** Ranges no page worth reading lives in, including cloud metadata at 169.254.169.254. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "")
  if (!ip) return true

  if (ip.includes(":")) {
    const groups = expandV6(ip)
    if (!groups) return true
    const v4At = (hi: number, lo: number) => [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join(".")
    // Loopback (::1) and unspecified (::).
    if (groups.slice(0, 7).every((g) => g === 0) && (groups[7] === 0 || groups[7] === 1)) return true
    // IPv4-mapped (::ffff:w.x.y.z), IPv4-compatible (::w.x.y.z), SIIT (::ffff:0:w.x.y.z), and NAT64 (64:ff9b::/96, 64:ff9b:1::/48).
    const mappedV4 = groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)
    const siitV4 = groups.slice(0, 4).every((g) => g === 0) && groups[4] === 0xffff && groups[5] === 0
    const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && (groups.slice(2, 6).every((g) => g === 0) || groups[2] === 1)
    if (mappedV4 || siitV4 || nat64) return isPrivateAddress(v4At(groups[6]!, groups[7]!))
    // 6to4 (2002::/16) carries a v4 address in groups 1..2; Teredo (2001:0::/32) XORs one in groups 6..7.
    if (groups[0] === 0x2002) return isPrivateAddress(v4At(groups[1]!, groups[2]!))
    if (groups[0] === 0x2001 && groups[1] === 0) return isPrivateAddress(v4At(groups[6]! ^ 0xffff, groups[7]! ^ 0xffff))
    // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8).
    const g0 = groups[0]!
    return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00
  }

  const octets = parseIpv4Octets(ip)
  if (!octets) return true
  const [a, b, c] = octets
  if (a === 0 || a === 127 || a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 192 && b === 0 && c === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

/**
 * The network, injectable.
 *
 * `address` is the verified IP returned by `resolve`, so the real client pins
 * the TCP connection to that exact IP instead of asking DNS a second time.
 */
export type Network = {
  fetch: (url: URL, init: RequestInit, address?: string) => Promise<Response>
  resolve: (hostname: string) => Promise<string[]>
}

function isReadableType(type: string): boolean {
  const lower = type.toLowerCase()
  return lower.includes("html") || lower.includes("text") || lower.includes("json") || lower.includes("xml") || lower === ""
}

function concatCapped(chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const size = Math.min(total, MAX_BYTES)
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= size) break
    const room = Math.min(chunk.length, size - offset)
    joined.set(chunk.subarray(0, room), offset)
    offset += room
  }
  return joined
}

/** Connects directly to `address` when given, preserving Host and TLS SNI, and caps both wire and decoded bytes. */
export function pinnedFetch(url: URL, init: RequestInit, address?: string): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const bareHost = url.hostname.replace(/^\[|\]$/g, "")
    const isHttps = url.protocol === "https:"
    const transport = isHttps ? https : http
    const reqHeaders: Record<string, string> = { "accept-encoding": "gzip, deflate, br" }
    if (init.headers) {
      const given = new Headers(init.headers)
      given.forEach((value, key) => { reqHeaders[key] = value })
    }
    const req = transport.request(
      url,
      {
        method: init.method ?? "GET",
        headers: reqHeaders,
        signal: init.signal ?? undefined,
        ...(isHttps && !net.isIP(bareHost) ? { servername: bareHost } : {}),
        ...(address
          ? {
              lookup: (_host, opts: unknown, cb: (...args: any[]) => void) => {
                const family = address.includes(":") ? 6 : 4
                const all = Boolean(opts && typeof opts === "object" && (opts as { all?: boolean }).all)
                if (all) cb(null, [{ address, family }])
                else cb(null, address, family)
              },
            }
          : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          headers.set(key, Array.isArray(value) ? value.join(", ") : value)
        }
        // Redirects and non-text responses never need their body read.
        if ((status >= 300 && status < 400) || !isReadableType(headers.get("content-type") ?? "")) {
          res.destroy()
          resolve(new Response(null, { status, headers }))
          return
        }

        const encoding = (headers.get("content-encoding") ?? "").toLowerCase().trim()
        const decoder =
          encoding === "gzip" || encoding === "x-gzip"
            ? zlib.createGunzip()
            : encoding === "deflate"
              ? zlib.createInflate()
              : encoding === "br"
                ? zlib.createBrotliDecompress()
                : undefined
        if (decoder) {
          headers.delete("content-encoding")
          headers.delete("content-length")
        }

        const chunks: Uint8Array[] = []
        let wireBytes = 0
        let decodedBytes = 0
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve(new Response(concatCapped(chunks, decodedBytes), { status, headers }))
        }
        const fail = (err: Error) => {
          if (settled) return
          settled = true
          reject(err)
        }

        if (!decoder) {
          res.on("data", (chunk: Buffer) => {
            wireBytes += chunk.length
            decodedBytes += chunk.length
            chunks.push(chunk)
            if (wireBytes >= MAX_BYTES) {
              res.destroy()
              finish()
            }
          })
          res.on("end", finish)
          res.on("close", finish)
          res.on("error", (err) => (wireBytes >= MAX_BYTES ? finish() : fail(err)))
          return
        }

        res.on("data", (chunk: Buffer) => {
          wireBytes += chunk.length
          if (wireBytes > MAX_BYTES) {
            res.destroy()
            decoder.end()
          } else {
            decoder.write(chunk)
          }
        })
        res.on("end", () => decoder.end())
        res.on("error", (err) => (wireBytes > MAX_BYTES || decodedBytes >= MAX_BYTES ? finish() : fail(err)))

        decoder.on("data", (chunk: Buffer) => {
          decodedBytes += chunk.length
          chunks.push(chunk)
          if (decodedBytes >= MAX_BYTES) {
            res.destroy()
            decoder.destroy()
            finish()
          }
        })
        decoder.on("end", finish)
        decoder.on("close", finish)
        decoder.on("error", (err) => (decodedBytes >= MAX_BYTES || wireBytes > MAX_BYTES ? finish() : fail(err)))
      },
    )
    req.on("error", reject)
    req.end()
  })
}

const realNetwork: Network = {
  fetch: (url, init, address) => pinnedFetch(url, init, address),
  resolve: async (hostname) => {
    const bare = hostname.replace(/^\[|\]$/g, "")
    if (net.isIP(bare)) return [bare]
    return (await dns.lookup(bare, { all: true })).map((entry) => entry.address)
  },
}

/** Refuse before connecting, and return the public address the connection must be pinned to. */
async function assertPublic(hostname: string, network: Network): Promise<string> {
  const bare = hostname.replace(/^\[|\]$/g, "")
  if (net.isIP(bare) && isPrivateAddress(bare)) {
    throw new Error(`refusing to fetch ${hostname}: it resolves to the private address ${bare}`)
  }
  let addresses: string[]
  try {
    addresses = await network.resolve(bare)
  } catch {
    throw new Error(`cannot resolve ${hostname}`)
  }
  if (!addresses.length) throw new Error(`cannot resolve ${hostname}`)
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`refusing to fetch ${hostname}: it resolves to the private address ${address}`)
    }
  }
  return addresses[0]!
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
  return new TextDecoder("utf-8").decode(concatCapped(chunks, total))
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
    const address = await assertPublic(url.hostname, network)
    visited.push(url.toString())

    const response = await network.fetch(
      url,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
      },
      address,
    )

    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url)
      continue
    }

    if (!response.ok) throw new Error(`${url.hostname} returned ${response.status}`)

    const type = (response.headers.get("content-type") ?? "").toLowerCase()
    if (!isReadableType(type)) {
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
