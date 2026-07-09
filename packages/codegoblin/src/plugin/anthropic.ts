import type { Hooks, PluginInput } from "@codegoblin/plugin"
import * as Log from "@codegoblin/core/util/log"
import { OAUTH_DUMMY_KEY } from "../auth"

const log = Log.create({ service: "plugin.anthropic" })

// Anthropic's official OAuth client for CLI tooling (the same public client id
// Claude Code uses). Pro/Max authorization happens on claude.ai; the console
// variant authorizes on console.anthropic.com and can mint an API key.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token"
const CREATE_KEY_ENDPOINT = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"
const SCOPES = "org:create_api_key user:profile user:inference"
const OAUTH_BETA = "oauth-2025-04-20"
// OAuth-authenticated inference is scoped to Claude Code, so requests must
// carry its identity as the first system block.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(hash) }
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function buildAuthorizeUrl(base: "claude.ai" | "console.anthropic.com", pkce: PkceCodes) {
  const url = new URL(`https://${base}/oauth/authorize`)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("scope", SCOPES)
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", pkce.verifier)
  return url.toString()
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
}

async function exchangeCode(pasted: string, verifier: string): Promise<TokenResponse> {
  // The callback page shows the value as "code#state"; accept a bare code too.
  const [code, state] = pasted.trim().split("#")
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state: state ?? verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })
  if (!response.ok) throw new Error(`token exchange failed: HTTP ${response.status} ${await response.text()}`)
  return (await response.json()) as TokenResponse
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) throw new Error(`token refresh failed: HTTP ${response.status} ${await response.text()}`)
  return (await response.json()) as TokenResponse
}

/**
 * Ensure the request body's system prompt starts with the Claude Code identity
 * block. OAuth tokens are only authorized for Claude Code traffic; anything
 * else is rejected by the API.
 */
function withClaudeCodeSystem(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const system = parsed.system
    const identityBlock = { type: "text", text: CLAUDE_CODE_IDENTITY }
    if (typeof system === "string") {
      parsed.system = system.startsWith(CLAUDE_CODE_IDENTITY) ? system : [identityBlock, { type: "text", text: system }]
    } else if (Array.isArray(system)) {
      const first = system[0] as { text?: string } | undefined
      if (!first || typeof first.text !== "string" || !first.text.startsWith(CLAUDE_CODE_IDENTITY)) {
        parsed.system = [identityBlock, ...system]
      }
    } else {
      parsed.system = [identityBlock]
    }
    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

function mergeBetaHeader(headers: Headers) {
  const existing = headers.get("anthropic-beta")
  const values = new Set(
    (existing ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  )
  values.add(OAUTH_BETA)
  headers.set("anthropic-beta", [...values].join(","))
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Single-flight refresh, mirroring the xAI plugin: collapse concurrent
        // fetches onto one token refresh so a rotating refresh_token isn't replayed.
        let refreshPromise: Promise<{ access: string; refresh: string; expires: number }> | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            let currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            if (!currentAuth.expires || currentAuth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS) {
              if (!refreshPromise) {
                const refreshToken = currentAuth.refresh
                log.info("refreshing anthropic access token")
                refreshPromise = refreshAccessToken(refreshToken)
                  .then(async (tokens) => {
                    const expires = Date.now() + (tokens.expires_in ?? 3600) * 1000
                    const refresh = tokens.refresh_token || refreshToken
                    await input.client.auth
                      .set({
                        path: { id: "anthropic" },
                        body: { type: "oauth", access: tokens.access_token, refresh, expires },
                      })
                      .catch((err) => log.warn("failed to persist refreshed anthropic tokens", { error: err }))
                    return { access: tokens.access_token, refresh, expires }
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }
              const refreshed = await refreshPromise
              currentAuth = { ...currentAuth, ...refreshed }
            }

            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
            if (init?.headers) {
              const entries =
                init.headers instanceof Headers
                  ? init.headers.entries()
                  : Array.isArray(init.headers)
                    ? init.headers
                    : Object.entries(init.headers as Record<string, string | undefined>)
              for (const [key, value] of entries) {
                if (value !== undefined) headers.set(key, String(value))
              }
            }
            // OAuth requests authenticate with a bearer token; an x-api-key
            // header (the AI SDK's dummy key) alongside it gets rejected.
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            mergeBetaHeader(headers)

            let body = init?.body
            if (typeof body === "string") body = withClaudeCodeSystem(body)

            return fetch(requestInput, { ...init, headers, body })
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max (subscription)",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()
            return {
              url: buildAuthorizeUrl("claude.ai", pkce),
              instructions: "Sign in with your Claude account, then paste the code shown on the callback page.",
              method: "code" as const,
              callback: async (code: string) => {
                try {
                  const tokens = await exchangeCode(code, pkce.verifier)
                  return {
                    type: "success" as const,
                    access: tokens.access_token,
                    refresh: tokens.refresh_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                } catch (err) {
                  log.error("anthropic pro/max oauth failed", { error: err })
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "Anthropic Console (creates an API key)",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()
            return {
              url: buildAuthorizeUrl("console.anthropic.com", pkce),
              instructions: "Sign in to the Anthropic Console, then paste the code shown on the callback page.",
              method: "code" as const,
              callback: async (code: string) => {
                try {
                  const tokens = await exchangeCode(code, pkce.verifier)
                  const response = await fetch(CREATE_KEY_ENDPOINT, {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      authorization: `Bearer ${tokens.access_token}`,
                    },
                  })
                  if (!response.ok) throw new Error(`create_api_key failed: HTTP ${response.status}`)
                  const data = (await response.json()) as { raw_key?: string }
                  if (!data.raw_key) throw new Error("create_api_key returned no key")
                  return { type: "success" as const, key: data.raw_key }
                } catch (err) {
                  log.error("anthropic console oauth failed", { error: err })
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
      ],
    },
  }
}
