import { createOpencodeClient } from "@codegoblin/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createFetchForServer(input: { server: ServerConnection.HttpBase; fetch?: typeof fetch }) {
  return (request: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(request instanceof Request ? request.url : request.toString(), input.server.url)
    if (target.origin !== new URL(input.server.url).origin) {
      throw new Error("Authenticated server requests must use the configured server origin")
    }
    const headers = new Headers(request instanceof Request ? request.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    if (input.server.password) {
      headers.set(
        "Authorization",
        `Basic ${authTokenFromCredentials({ username: input.server.username, password: input.server.password })}`,
      )
    }
    return (input.fetch ?? fetch)(request instanceof Request ? request : target, { ...init, headers })
  }
}
