import crypto from "node:crypto"
import dns from "node:dns/promises"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../platform/paths"
import { isPrivateAddress, type Network } from "./webfetch"

const network: Network = {
  fetch: (url, init) => fetch(url, init),
  resolve: async host => (await dns.lookup(host, { all: true })).map(entry => entry.address),
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown, max = 8192): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value)

export class McpAuthorizationRequired extends Error {
  constructor(readonly challenge = "") { super("Sign-in required; open /mcp to authorize this server") }
}

export type McpOAuthInfo = { endpoint: string; resource: string; issuer: string; authorize: string; token: string; register?: string; scope?: string; issuerParameter: boolean }
export type McpOAuthConfig = false | { clientId?: string; scope?: string }
type Credential = McpOAuthInfo & { clientId: string; accessToken: string; refreshToken?: string; expiresAt?: number }
export type McpOAuthLogin = { url: string; status: () => "pending" | "exchanging" | "complete" | "failed" | "cancelled"; cancel: () => void; done: Promise<boolean> }

/** Discovery and token responses never inherit configured MCP headers/cookies. */
async function endpoint(raw: string, net: Network): Promise<URL> {
  const url = new URL(raw)
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("MCP OAuth requires credential-free HTTPS endpoints")
  let timer: ReturnType<typeof setTimeout> | undefined
  const addresses = await Promise.race([net.resolve(url.hostname).catch(() => []), new Promise<string[]>(resolve => { timer = setTimeout(() => resolve([]), 5000) })]).finally(() => clearTimeout(timer))
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error("MCP OAuth refuses private-network endpoints")
  return url
}

async function requestJSON(raw: string, net: Network, init: RequestInit = {}) {
  const url = await endpoint(raw, net)
  const response = await net.fetch(url, { ...init, redirect: "manual", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { accept: "application/json", ...init.headers } })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error("MCP OAuth endpoint returned HTTP " + response.status)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("MCP OAuth endpoint returned no JSON")
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 65536) throw new Error("MCP OAuth response exceeded 64 KiB")
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw new Error("MCP OAuth endpoint returned invalid JSON") }
  if (!record(value)) throw new Error("MCP OAuth endpoint returned invalid JSON metadata")
  return value
}

const canonical = (url: URL) => url.pathname === "/" && !url.search ? url.origin : url.href
const parameter = (challenge: string, key: string) => {
  const bearer = /(?:^|,\s*)Bearer(?:\s+|$)(.*)/i.exec(challenge)?.[1] || ""
  const value = new RegExp("(?:^|[\\s,])" + key + '=(?:"([^"\\\\]*)"|([^\\s,]+))', "i").exec(bearer)
  return value?.[1] ?? value?.[2]
}

/** Only a resource in the configured endpoint's origin/path hierarchy is trusted. */
function validResource(raw: string, target: URL) {
  const value = new URL(raw)
  if (value.origin !== target.origin || value.search || value.hash || value.username || value.password || !(value.pathname === target.pathname || target.pathname.startsWith(value.pathname.replace(/\/$/, "") + "/"))) throw new Error("MCP OAuth resource does not match the configured server")
  return canonical(value)
}

export async function discoverMcpOAuth(raw: string, challenge = "", net: Network = network): Promise<McpOAuthInfo> {
  const target = await endpoint(raw, net)
  if (target.search) throw new Error("MCP OAuth resource URLs cannot include a query")
  const hinted = parameter(challenge, "resource_metadata")
  const urls = hinted ? [hinted] : [...new Set([target.origin + "/.well-known/oauth-protected-resource" + target.pathname.replace(/\/$/, ""), target.origin + "/.well-known/oauth-protected-resource"])]
  let resource: Record<string, unknown> | undefined
  for (const url of urls) {
    const checked = await endpoint(url, net)
    if (checked.origin !== target.origin) throw new Error("MCP resource metadata must remain on the configured origin")
    try { resource = await requestJSON(url, net); break } catch { /* Try the documented root fallback. */ }
  }
  if (!resource || !text(resource.resource) || !Array.isArray(resource.authorization_servers) || !text(resource.authorization_servers[0])) throw new Error("MCP OAuth protected resource metadata unavailable")
  const resourceId = validResource(resource.resource, target)
  const issuer = await endpoint(resource.authorization_servers[0], net)
  if (issuer.search) throw new Error("MCP OAuth issuer cannot include a query")
  const issuerId = canonical(issuer)
  const suffix = issuer.pathname.replace(/\/$/, "")
  const candidates = [...new Set([issuer.origin + "/.well-known/oauth-authorization-server" + suffix, issuer.origin + "/.well-known/openid-configuration" + suffix, issuerId + "/.well-known/openid-configuration"])]
  let metadata: Record<string, unknown> | undefined
  for (const url of candidates) {
    try { metadata = await requestJSON(url, net); break } catch { /* Try OAuth metadata, then OIDC. */ }
  }
  if (!metadata || !text(metadata.issuer) || canonical(new URL(metadata.issuer)) !== issuerId || !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256")) throw new Error("MCP OAuth issuer mismatch or S256 PKCE unavailable")
  await endpoint(metadata.issuer, net)
  if (!text(metadata.authorization_endpoint) || !text(metadata.token_endpoint)) throw new Error("MCP OAuth authorization/token endpoints unavailable")
  await endpoint(metadata.authorization_endpoint, net)
  await endpoint(metadata.token_endpoint, net)
  if (text(metadata.registration_endpoint)) await endpoint(metadata.registration_endpoint, net)
  const scope = parameter(challenge, "scope") ?? (Array.isArray(resource.scopes_supported) && resource.scopes_supported.every(s => typeof s === "string") ? resource.scopes_supported.join(" ") : undefined)
  if (scope && (scope.length > 2048 || /[\x00-\x1f\x7f]/.test(scope))) throw new Error("Invalid MCP OAuth scope")
  return { endpoint: target.href, resource: resourceId, issuer: issuerId, authorize: metadata.authorization_endpoint, token: metadata.token_endpoint, ...(text(metadata.registration_endpoint) ? { register: metadata.registration_endpoint } : {}), ...(scope ? { scope } : {}), issuerParameter: metadata.authorization_response_iss_parameter_supported === true }
}

const credentialFile = (raw: string) => path.join(Global.Path.data, "mcp-oauth", crypto.createHash("sha256").update(new URL(raw).href).digest("hex") + ".json")

async function saveCredential(value: Credential) {
  const file = credentialFile(value.endpoint)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = file + "." + crypto.randomUUID() + ".tmp"
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await fs.rename(temporary, file)
}

function tokenCredential(value: Record<string, unknown>, info: McpOAuthInfo, clientId: string, previous?: Credential): Credential {
  if (!text(value.access_token, 16384) || String(value.token_type).toLowerCase() !== "bearer") throw new Error("MCP OAuth did not return a valid Bearer token")
  if (value.refresh_token !== undefined && !text(value.refresh_token, 16384)) throw new Error("MCP OAuth returned an invalid refresh token")
  if (value.expires_in !== undefined && (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 31536000)) throw new Error("MCP OAuth returned an invalid expiry")
  return { ...info, clientId, accessToken: value.access_token, ...(text(value.refresh_token, 16384) ? { refreshToken: value.refresh_token } : previous?.refreshToken ? { refreshToken: previous.refreshToken } : {}), ...(typeof value.expires_in === "number" ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}) }
}

const refreshes = new Map<string, Promise<string | undefined>>()

/** Automatic refresh is bounded and single-flight; 401 never retries a tool call. */
export async function mcpAccessToken(raw: string, net: Network = network): Promise<string | undefined> {
  if (refreshes.has(raw)) return refreshes.get(raw)
  const pending = (async () => {
    let value: unknown
    try {
      const file = credentialFile(raw)
      if ((await fs.stat(file)).size > 65536) return
      value = JSON.parse(await fs.readFile(file, "utf8"))
    } catch { return }
    if (!record(value) || value.endpoint !== new URL(raw).href || !text(value.accessToken, 16384) || !text(value.clientId) || !text(value.resource) || !text(value.issuer) || !text(value.token) || !text(value.authorize)) return
    const credential = value as Credential
    const target = await endpoint(raw, net)
    validResource(credential.resource, target)
    if (credential.expiresAt !== undefined && (typeof credential.expiresAt !== "number" || !Number.isFinite(credential.expiresAt))) return
    if (credential.expiresAt === undefined || credential.expiresAt > Date.now() + 30000) return credential.accessToken
    if (!text(credential.refreshToken, 16384)) throw new McpAuthorizationRequired()
    try {
      const response = await requestJSON(credential.token, net, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refreshToken, client_id: credential.clientId, resource: credential.resource }) })
      const refreshed = tokenCredential(response, credential, credential.clientId, credential)
      await saveCredential(refreshed)
      return refreshed.accessToken
    } catch { throw new McpAuthorizationRequired() }
  })()
  refreshes.set(raw, pending)
  try { return await pending } finally { refreshes.delete(raw) }
}

/** A user gesture starts registration; no model or automatic connection can authorize. */
export async function beginMcpOAuth(info: McpOAuthInfo, config: Exclude<McpOAuthConfig, false> = {}, net: Network = network): Promise<McpOAuthLogin> {
  await endpoint(info.endpoint, net)
  const verifier = crypto.randomBytes(32).toString("base64url")
  const state = crypto.randomBytes(32).toString("base64url")
  const abort = new AbortController()
  let status: ReturnType<McpOAuthLogin["status"]> = "pending"
  let finish!: (success: boolean) => void
  const done = new Promise<boolean>(resolve => { finish = resolve })
  let clientId = config.clientId
  let redirect = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const end = (next: typeof status, success = false) => {
    if (status === "complete" || status === "failed" || status === "cancelled") return
    status = next
    clearTimeout(timer)
    abort.abort()
    finish(success)
    setTimeout(() => { void server.stop(true) }, 100).unref()
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "content-type": "text/plain", "x-content-type-options": "nosniff" }
    if (request.method !== "GET" || request.headers.get("host") !== "127.0.0.1:" + server.port || url.pathname !== "/mcp/oauth/callback" || request.headers.get("origin")) return new Response("Not found", { status: 404, headers })
    const received = url.searchParams.get("state") || ""
    if (!/^[a-zA-Z0-9_-]{43}$/.test(received) || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(state))) return new Response("Invalid sign-in state", { status: 400, headers })
    if (status !== "pending") return new Response("This sign-in is no longer pending", { status: 409, headers })
    const issuer = url.searchParams.get("iss")
    if ((issuer && issuer !== info.issuer) || (info.issuerParameter && !issuer)) { end("failed"); return new Response("Issuer mismatch", { status: 400, headers }) }
    if (url.searchParams.has("error")) { end("failed"); return new Response("Authorization declined; return to CG-Next", { headers }) }
    const code = url.searchParams.get("code")
    if (!text(code)) return new Response("Missing authorization code", { status: 400, headers })
    status = "exchanging"
    try {
      const response = await requestJSON(info.token, net, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: abort.signal, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId!, redirect_uri: redirect, code_verifier: verifier, resource: info.resource }) })
      if (abort.signal.aborted) throw new Error("Cancelled")
      await saveCredential(tokenCredential(response, info, clientId!))
      end("complete", true)
      return new Response("MCP signed in. Return to CG-Next and check the connection.", { headers })
    } catch { end("failed"); return new Response("Sign-in failed; return to CG-Next and retry", { status: 400, headers }) }
  } })
  redirect = "http://127.0.0.1:" + server.port + "/mcp/oauth/callback"
  try {
    if (!clientId) {
      if (!info.register) throw new Error("This server needs a pre-registered public oauth.clientId; dynamic registration is unavailable")
      const response = await requestJSON(info.register, net, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "CG-Next MCP", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) })
      if (!text(response.client_id) || (response.token_endpoint_auth_method !== undefined && response.token_endpoint_auth_method !== "none")) throw new Error("MCP OAuth requires a public PKCE client")
      if (response.redirect_uris !== undefined && (!Array.isArray(response.redirect_uris) || !response.redirect_uris.includes(redirect))) throw new Error("MCP OAuth registration did not accept the callback")
      clientId = response.client_id
    }
    if (!text(clientId)) throw new Error("Invalid MCP OAuth client ID")
    const url = await endpoint(info.authorize, net)
    const scope = config.scope ?? info.scope
    if (scope && (scope.length > 2048 || /[\x00-\x1f\x7f]/.test(scope))) throw new Error("Invalid MCP OAuth scope")
    for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirect, state, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: info.resource, ...(scope ? { scope } : {}) })) url.searchParams.set(key, value)
    timer = setTimeout(() => end("failed"), 5 * 60 * 1000)
    timer.unref()
    return { url: url.href, status: () => status, cancel: () => end("cancelled"), done }
  } catch (error) { end("failed"); throw error }
}
