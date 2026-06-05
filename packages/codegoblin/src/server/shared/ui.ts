import { AppFileSystem } from "@codegoblin/core/filesystem"
import { Flag } from "@codegoblin/core/flag/flag"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ProxyUtil } from "../proxy-util"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined
let localDistCache: string | null | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' data: blob:; connect-src * data: blob:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2].replace(/\r\n?/g, "\n")).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(pathname: string, upstream = UI_UPSTREAM) {
  return new URL(pathname, upstream).toString()
}

function parseURL(value: string | undefined) {
  if (!value) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

export function webUIUpstream() {
  return parseURL(Flag.CODEGOBLIN_WEB_UI_UPSTREAM)
}

export function webUIDevURL() {
  return parseURL(Flag.CODEGOBLIN_WEB_UI_DEV_URL)
}

function distHasIndex(dist: string) {
  try {
    return fs.statSync(path.join(dist, "index.html")).isFile()
  } catch {
    return false
  }
}

export function resolveLocalWebUIDist() {
  if (localDistCache !== undefined) return localDistCache

  const fromEnv = Flag.CODEGOBLIN_WEB_UI_PATH
  if (fromEnv) {
    const resolved = path.resolve(fromEnv)
    localDistCache = distHasIndex(resolved) ? resolved : null
    return localDistCache
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, "../../../../app/dist"),
    path.resolve(process.cwd(), "packages/app/dist"),
    path.resolve(process.cwd(), "../app/dist"),
  ]

  for (const candidate of candidates) {
    if (distHasIndex(candidate)) {
      localDistCache = candidate
      return localDistCache
    }
  }

  localDistCache = null
  return localDistCache
}

export function resetUIResolutionCacheForTests() {
  embeddedUIPromise = undefined
  localDistCache = undefined
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("codegoblin-web-ui.gen.ts")
      .then((module) => module.default as Record<string, string>)
      .catch(() =>
        // @ts-expect-error - legacy generated filename from older builds
        import("opencode-web-ui.gen.ts")
          .then((module) => module.default as Record<string, string>)
          .catch(() => null),
      ))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function unavailableUIResponse() {
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>CodeGoblin web UI unavailable</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 42rem; line-height: 1.5; }
      code { background: #f4f4f5; padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
      h1 { font-size: 1.5rem; }
    </style>
  </head>
  <body>
    <h1>CodeGoblin web UI unavailable</h1>
    <p>This server is running without an embedded UI bundle.</p>
    <p>Choose one of these options:</p>
    <ul>
      <li>Build and embed the UI: <code>bun run --cwd packages/codegoblin build --single --skip-install</code></li>
      <li>Serve a local app build: <code>bun run --cwd packages/app build</code>, then restart <code>codegoblin web</code></li>
      <li>Run split dev mode: backend <code>codegoblin serve</code> plus app dev server in <code>packages/app</code></li>
      <li>Point at a dev server: set <code>CODEGOBLIN_WEB_UI_DEV_URL=http://127.0.0.1:4444</code></li>
      <li>Opt in to an upstream UI proxy: set <code>CODEGOBLIN_WEB_UI_UPSTREAM=https://example.com</code></li>
    </ul>
  </body>
</html>`

  return HttpServerResponse.text(html, {
    status: 503,
    headers: new Headers({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp(),
    }),
  })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = AppFileSystem.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

function resolveDistAsset(distRoot: string, requestPath: string) {
  const rel = requestPath.replace(/^\//, "") || "index.html"
  const candidate = path.resolve(distRoot, rel)
  const root = path.resolve(distRoot)
  if (!candidate.startsWith(root + path.sep) && candidate !== root) {
    return path.join(root, "index.html")
  }
  return candidate
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: AppFileSystem.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveLocalDistUIEffect(requestPath: string, distRoot: string, fs: AppFileSystem.Interface) {
  const asset = resolveDistAsset(distRoot, requestPath)

  return fs.existsSafe(asset).pipe(
    Effect.flatMap((exists) => {
      const fallback =
        !exists && !path.extname(requestPath.replace(/^\//, ""))
          ? path.join(distRoot, "index.html")
          : exists
            ? asset
            : null
      if (!fallback) return Effect.succeed(notFound())

      const served = fallback === asset ? asset : fallback
      const servedRel = path.relative(distRoot, served).replaceAll("\\", "/")
      return fs.readFile(served).pipe(
        Effect.map((body) => embeddedUIResponse(servedRel || "index.html", body)),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
      )
    }),
  )
}

function proxyUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  upstream: URL,
  client: HttpClient.HttpClient,
) {
  return Effect.gen(function* () {
    const pathname = new URL(request.url, "http://localhost").pathname
    const response = yield* client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(pathname, upstream), {
        headers: ProxyUtil.headers(request.headers, { host: upstream.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: AppFileSystem.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const pathname = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(pathname, services.fs, embeddedWebUI)

    const localDist = resolveLocalWebUIDist()
    if (localDist) return yield* serveLocalDistUIEffect(pathname, localDist, services.fs)

    const devURL = webUIDevURL()
    if (devURL) return yield* proxyUIEffect(request, devURL, services.client)

    const upstream = webUIUpstream()
    if (upstream) return yield* proxyUIEffect(request, upstream, services.client)

    return unavailableUIResponse()
  })
}
