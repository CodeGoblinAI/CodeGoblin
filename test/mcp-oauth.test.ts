import { afterEach, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { beginMcpOAuth, discoverMcpOAuth, mcpAccessToken, type McpOAuthLogin } from "../src/core/mcp-oauth"
import { HttpTransport, McpClient } from "../src/core/mcp"
import { parseConfig } from "../src/core/config"
import { Global } from "../src/platform/paths"
import type { Network } from "../src/core/webfetch"
import { requireSandbox } from "./sandbox"

const servers: Bun.Server<undefined>[] = []
const logins: McpOAuthLogin[] = []
afterEach(async () => { logins.splice(0).forEach(login => login.cancel()); await Promise.all(servers.splice(0).map(server => server.stop(true))) })

function fixture(options: { pkce?: boolean; mismatch?: boolean; oidc?: boolean; redirect?: boolean; huge?: boolean } = {}) {
  const origin = "https://oauth-fixture.example"
  const resource = origin + "/mcp/" + crypto.randomUUID()
  const events: { path: string; body: Record<string, unknown>; authorization: string | null }[] = []
  let clientRedirect = ""
  let challenge = ""
  let revoked = false
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    const authorization = request.headers.get("authorization")
    const body = request.method === "POST" ? (request.headers.get("content-type")?.includes("json") ? await request.json() as Record<string, unknown> : Object.fromEntries(new URLSearchParams(await request.text()))) : {}
    events.push({ path: url.pathname, body, authorization })
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource, authorization_servers: [origin + "/tenant"], scopes_supported: ["read"] })
    if (url.pathname.includes(".well-known")) {
      if (options.oidc && url.pathname.includes("oauth-authorization-server")) return new Response("", { status: 404 })
      if (options.redirect) return new Response("", { status: 302, headers: { location: "http://127.0.0.1/private" } })
      if (options.huge) return new Response(" ".repeat(65537))
      return Response.json({ issuer: origin + (options.mismatch ? "/other" : "/tenant"), authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", registration_endpoint: origin + "/register", code_challenge_methods_supported: options.pkce === false ? ["plain"] : ["S256"] })
    }
    if (url.pathname === "/register") {
      clientRedirect = (body.redirect_uris as string[])[0]!
      return Response.json({ client_id: "fixture-client", token_endpoint_auth_method: "none", redirect_uris: [clientRedirect] })
    }
    if (url.pathname === "/token") {
      expect(body.resource).toBe(resource)
      expect(authorization).toBeNull()
      if (body.grant_type === "authorization_code") {
        expect(body.redirect_uri).toBe(clientRedirect)
        expect(crypto.createHash("sha256").update(String(body.code_verifier)).digest("base64url")).toBe(challenge)
      }
      return Response.json({ access_token: body.grant_type === "refresh_token" ? "rotated-fixture-token" : "fixture-token", token_type: "Bearer", refresh_token: "fixture-refresh", expires_in: 3600 })
    }
    if (url.pathname.startsWith("/mcp/")) {
      if (!authorization || revoked) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer scope="read"' } })
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture" } } })
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lookup" }] } })
      return new Response("", { status: 202 })
    }
    return new Response("", { status: 404 })
  } })
  servers.push(server)
  const net: Network = { resolve: async () => ["203.0.113.42"], fetch: (url, init) => fetch("http://127.0.0.1:" + server.port + url.pathname + url.search, init) }
  return { resource, net, events, setChallenge: (value: string) => { challenge = value }, revoke: () => { revoked = true } }
}

test("parses public MCP OAuth options and never adopts client secrets", () => {
  const value = parseConfig(JSON.stringify({ mcp: { on: { type: "remote", url: "https://example.com/mcp", oauth: { clientId: "public", clientSecret: "not-adopted", scope: "read" } }, off: { type: "remote", url: "https://example.com/mcp", oauth: false } } }))
  expect(value.mcp.on).toMatchObject({ oauth: { clientId: "public", scope: "read" } })
  expect(value.mcp.off).toMatchObject({ oauth: false })
})

test("discovery follows challenge metadata, scopes and issuer-path OIDC fallback", async () => {
  const f = fixture({ oidc: true })
  const info = await discoverMcpOAuth(f.resource, 'Bearer resource_metadata="https://oauth-fixture.example/.well-known/oauth-protected-resource", scope="look"', f.net)
  expect(info.scope).toBe("look")
  expect(info.issuer).toBe("https://oauth-fixture.example/tenant")
  expect(f.events.map(event => event.path)).toContain("/.well-known/openid-configuration/tenant")
  expect(f.events.every(event => event.authorization === null)).toBe(true)
})

test("refuses absent S256, issuer mismatch, redirects, oversized and private endpoints", async () => {
  for (const option of [{ pkce: false }, { mismatch: true }, { redirect: true }, { huge: true }]) {
    const f = fixture(option)
    await expect(discoverMcpOAuth(f.resource, "", f.net)).rejects.toThrow()
    expect(f.events.every(event => event.path !== "/register")).toBe(true)
  }
  const f = fixture()
  await expect(discoverMcpOAuth(f.resource, "", { ...f.net, resolve: async () => ["127.0.0.1"] })).rejects.toThrow("private-network")
  await expect(discoverMcpOAuth(f.resource, 'Bearer resource_metadata="https://other.example/metadata"', f.net)).rejects.toThrow("configured origin")
})

test("real loopback callback rejects wrong state and origin, uses PKCE/resource, reconnects and refreshes single-flight", async () => {
  const f = fixture()
  const info = await discoverMcpOAuth(f.resource, "", f.net)
  const login = await beginMcpOAuth(info, {}, f.net)
  logins.push(login)
  const authorize = new URL(login.url)
  f.setChallenge(authorize.searchParams.get("code_challenge")!)
  expect(authorize.searchParams.get("resource")).toBe(f.resource)
  const callback = new URL(authorize.searchParams.get("redirect_uri")!)
  callback.searchParams.set("code", "fixture-code")
  callback.searchParams.set("state", "wrong")
  expect((await fetch(callback)).status).toBe(400)
  callback.searchParams.set("state", "😀".repeat(21) + "x")
  expect((await fetch(callback)).status).toBe(400)
  callback.searchParams.set("state", authorize.searchParams.get("state")!)
  expect((await fetch(callback, { headers: { origin: "https://untrusted.example" } })).status).toBe(404)
  expect(f.events.filter(event => event.path === "/token")).toHaveLength(0)
  expect((await fetch(callback)).status).toBe(200)
  expect(await login.done).toBe(true)
  expect(login.status()).toBe("complete")
  expect(await mcpAccessToken(f.resource, f.net)).toBe("fixture-token")
  const client = new McpClient("fixture", { type: "remote", url: f.resource, headers: {}, enabled: true }, config => new HttpTransport(config.type === "remote" ? config.url : "", {}, {}, f.net))
  await client.connect()
  expect(client.status).toBe("connected")
  expect(f.events.filter(event => event.path.startsWith("/mcp/")).every(event => event.authorization === "Bearer fixture-token")).toBe(true)
  f.revoke()
  expect(await client.callTool("lookup", {})).toContain("Sign-in required")
  expect(client.status).toBe("authorization_required")
  expect(client.tools).toEqual([])
  expect(f.events.filter(event => event.body.method === "tools/call")).toHaveLength(1)
  await client.close()
  const file = path.join(Global.Path.data, "mcp-oauth", crypto.createHash("sha256").update(f.resource).digest("hex") + ".json")
  requireSandbox(file, "MCP OAuth test credentials")
  const stored = JSON.parse(await fs.readFile(file, "utf8"))
  await fs.writeFile(file, JSON.stringify({ ...stored, expiresAt: Date.now() - 1 }))
  expect(await Promise.all([mcpAccessToken(f.resource, f.net), mcpAccessToken(f.resource, f.net)])).toEqual(["rotated-fixture-token", "rotated-fixture-token"])
  expect(f.events.filter(event => event.path === "/token" && event.body.grant_type === "refresh_token")).toHaveLength(1)
})

test("issuer mismatch or declined consent never exchanges or stores a token", async () => {
  for (const decline of [false, true]) {
    const f = fixture()
    const info = await discoverMcpOAuth(f.resource, "", f.net)
    const login = await beginMcpOAuth({ ...info, issuerParameter: true }, {}, f.net)
    logins.push(login)
    const url = new URL(login.url)
    const callback = new URL(url.searchParams.get("redirect_uri")!)
    callback.searchParams.set("state", url.searchParams.get("state")!)
    callback.searchParams.set("iss", decline ? info.issuer : "https://other.example")
    callback.searchParams.set(decline ? "error" : "code", decline ? "access_denied" : "untrusted-code")
    await fetch(callback)
    expect(await login.done).toBe(false)
    expect(await mcpAccessToken(f.resource, f.net)).toBeUndefined()
    expect(f.events.filter(event => event.path === "/token")).toHaveLength(0)
  }
})

test("401 stays authorization-required; disabled OAuth keeps explicit HTTP behavior; cancel saves nothing", async () => {
  const f = fixture()
  const client = new McpClient("fixture", { type: "remote", url: f.resource, headers: {}, enabled: true }, () => new HttpTransport(f.resource, {}, {}, f.net))
  await client.connect()
  expect(client.status).toBe("authorization_required")
  expect(client.tools).toEqual([])
  const disabled = new McpClient("fixture", { type: "remote", url: f.resource, headers: {}, enabled: true, oauth: false }, () => new HttpTransport(f.resource, {}, false, f.net))
  await disabled.connect()
  expect(disabled.status).toBe("failed")
  const login = await beginMcpOAuth(await discoverMcpOAuth(f.resource, "", f.net), {}, f.net)
  logins.push(login)
  login.cancel()
  expect(await login.done).toBe(false)
  expect(await mcpAccessToken(f.resource, f.net)).toBeUndefined()
})
