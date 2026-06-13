import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Flag } from "@codegoblin/core/flag/flag"
import * as Log from "@codegoblin/core/util/log"
import { ConfigProvider, Effect, Layer } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { AppFileSystem } from "@codegoblin/core/filesystem"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ServerAuth } from "../../src/server/auth"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { serveEmbeddedUIEffect, serveLocalDistUIEffect, serveUIEffect, resetUIResolutionCacheForTests } from "../../src/server/shared/ui"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = {
      OPENCODE_SERVER_PASSWORD: Flag.CODEGOBLIN_SERVER_PASSWORD,
      OPENCODE_SERVER_USERNAME: Flag.CODEGOBLIN_SERVER_USERNAME,
      envPassword: process.env.OPENCODE_SERVER_PASSWORD,
      envUsername: process.env.OPENCODE_SERVER_USERNAME,
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Flag.CODEGOBLIN_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
        Flag.CODEGOBLIN_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
        restoreEnv("OPENCODE_SERVER_PASSWORD", original.envPassword)
        restoreEnv("OPENCODE_SERVER_USERNAME", original.envUsername)
      }),
    )
  }),
)

const it = testEffect(Layer.mergeAll(testStateLayer, AppFileSystem.defaultLayer, RuntimeFlags.layer()))

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

function withProxyOnlyUIEffect<A, E, R>(run: Effect.Effect<A, E, R>, upstream = "https://app.opencode.ai") {
  return Effect.gen(function* () {
    const previousUpstream = process.env.CODEGOBLIN_WEB_UI_UPSTREAM
    const previousDev = process.env.CODEGOBLIN_WEB_UI_DEV_URL
    const previousPath = process.env.CODEGOBLIN_WEB_UI_PATH
    process.env.CODEGOBLIN_WEB_UI_UPSTREAM = upstream
    delete process.env.CODEGOBLIN_WEB_UI_DEV_URL
    process.env.CODEGOBLIN_WEB_UI_PATH = mkdtempSync(path.join(tmpdir(), "cg-ui-empty-"))
    resetUIResolutionCacheForTests()

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        restoreEnv("CODEGOBLIN_WEB_UI_UPSTREAM", previousUpstream)
        restoreEnv("CODEGOBLIN_WEB_UI_DEV_URL", previousDev)
        restoreEnv("CODEGOBLIN_WEB_UI_PATH", previousPath)
        resetUIResolutionCacheForTests()
      }),
    )

    return yield* run
  })
}

function app(input?: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input?.password,
            OPENCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

function uiApp(input?: {
  password?: string
  username?: string
  client?: Layer.Layer<HttpClient.HttpClient>
  disableEmbeddedWebUi?: boolean
}) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
        )
      }),
    ).pipe(
      Layer.provide(authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))),
      Layer.provide([
        AppFileSystem.defaultLayer,
        input?.client ?? httpClient(new Response("ui")),
        RuntimeFlags.layer({ disableEmbeddedWebUi: input?.disableEmbeddedWebUi ?? false }),
        HttpServer.layerServices,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input?.password,
            OPENCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ]),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

function routeOrderingApp() {
  let proxiedUrl: string | undefined
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        yield* router.add("GET", "/session/:sessionID", () =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })),
        )
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
        )
      }),
    ).pipe(
      Layer.provide([
        AppFileSystem.defaultLayer,
        RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
        httpClient(new Response("ui"), (request) => {
          proxiedUrl = request.url
        }),
        HttpServer.layerServices,
      ]),
    ),
    { disableLogger: true },
  ).handler
  return {
    proxiedUrl: () => proxiedUrl,
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

function httpClient(response: Response, onRequest?: (request: HttpClientRequest.HttpClientRequest) => void) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      onRequest?.(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, response))
    }),
  )
}

function responseText(response: Response) {
  return Effect.promise(() => response.text())
}

describe("HttpApi UI fallback", () => {
  it.live("serves the web UI through an explicit upstream proxy", () =>
    withProxyOnlyUIEffect(
      Effect.gen(function* () {
        let proxiedUrl: string | undefined

        const response = yield* uiApp({
          disableEmbeddedWebUi: true,
          client: httpClient(
            new Response("<html>opencode</html>", { headers: { "content-type": "text/html" } }),
            (request) => {
              proxiedUrl = request.url
            },
          ),
        }).request("/")

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/html")
        expect(yield* responseText(response)).toBe("<html>opencode</html>")
        expect(proxiedUrl).toBe("https://app.opencode.ai/")
      }),
    ),
  )

  it.live("returns a CodeGoblin help page when no UI source is configured", () =>
    Effect.gen(function* () {
      resetUIResolutionCacheForTests()
      const previousUpstream = process.env.CODEGOBLIN_WEB_UI_UPSTREAM
      const previousDev = process.env.CODEGOBLIN_WEB_UI_DEV_URL
      const previousPath = process.env.CODEGOBLIN_WEB_UI_PATH
      delete process.env.CODEGOBLIN_WEB_UI_UPSTREAM
      delete process.env.CODEGOBLIN_WEB_UI_DEV_URL
      process.env.CODEGOBLIN_WEB_UI_PATH = mkdtempSync(path.join(tmpdir(), "cg-ui-empty-"))

      let proxied = false
      const response = yield* uiApp({
        disableEmbeddedWebUi: true,
        client: httpClient(new Response("should-not-proxy"), () => {
          proxied = true
        }),
      }).request("/")

      restoreEnv("CODEGOBLIN_WEB_UI_UPSTREAM", previousUpstream)
      restoreEnv("CODEGOBLIN_WEB_UI_DEV_URL", previousDev)
      restoreEnv("CODEGOBLIN_WEB_UI_PATH", previousPath)
      resetUIResolutionCacheForTests()

      expect(proxied).toBe(false)
      expect(response.status).toBe(503)
      expect(yield* responseText(response)).toContain("CodeGoblin web UI unavailable")
    }),
  )

  it.live("serves a local app dist build when embedded UI is disabled", () =>
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const response = yield* serveLocalDistUIEffect(
        "/",
        "/tmp/codegoblin-app-dist",
        {
          ...fs,
          existsSafe: (file) =>
            Effect.succeed(file === "/tmp/codegoblin-app-dist/index.html" || file.endsWith("index.html")),
          readFile: (file) =>
            file.endsWith("index.html")
              ? Effect.succeed(new TextEncoder().encode("<html>CodeGoblin</html>"))
              : Effect.die(`unexpected local UI path: ${file}`),
        },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(yield* responseText(response)).toBe("<html>CodeGoblin</html>")
    }),
  )

  it.live("strips upstream transfer encoding headers from proxied assets", () =>
    withProxyOnlyUIEffect(
      Effect.gen(function* () {
        let proxiedUrl: string | undefined

        const response = yield* Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          const client = yield* HttpClient.HttpClient
          const flags = yield* RuntimeFlags.Service
          return yield* serveUIEffect(HttpServerRequest.fromWeb(new Request("http://localhost/assets/app.js")), {
            fs,
            client,
            disableEmbeddedWebUi: flags.disableEmbeddedWebUi,
          })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) => {
                  proxiedUrl = request.url
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      new Response("console.log('ok')", {
                        headers: {
                          "content-encoding": "br",
                          "content-length": "999",
                          "content-type": "text/javascript",
                        },
                      }),
                    ),
                  )
                }),
              ),
            ),
          ),
          Effect.map(HttpServerResponse.toWeb),
        )

        expect(response.status).toBe(200)
        expect(proxiedUrl).toBe("https://app.opencode.ai/assets/app.js")
        expect(response.headers.get("content-encoding")).toBeNull()
        expect(response.headers.get("content-length")).not.toBe("999")
        expect(response.headers.get("content-type")).toContain("text/javascript")
        expect(yield* responseText(response)).toBe("console.log('ok')")
      }),
    ),
  )

  // Regression for #25698 (Ope): upstream `transfer-encoding: chunked` was
  // forwarded through the proxy while the proxy itself re-frames the body,
  // causing browsers to fail with `ERR_INVALID_CHUNKED_ENCODING`.
  it.live("strips upstream transfer-encoding header from proxied assets", () =>
    withProxyOnlyUIEffect(
      Effect.gen(function* () {
        const response = yield* Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          const client = yield* HttpClient.HttpClient
          const flags = yield* RuntimeFlags.Service
          return yield* serveUIEffect(HttpServerRequest.fromWeb(new Request("http://localhost/")), {
            fs,
            client,
            disableEmbeddedWebUi: flags.disableEmbeddedWebUi,
          })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      new Response("<html>opencode</html>", {
                        headers: {
                          "transfer-encoding": "chunked",
                          "content-type": "text/html",
                        },
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Effect.map(HttpServerResponse.toWeb),
        )

        expect(response.status).toBe(200)
        expect(response.headers.get("transfer-encoding")).toBeNull()
        expect(yield* responseText(response)).toBe("<html>opencode</html>")
      }),
    ),
  )

  it.live("serves embedded UI assets when Bun can read them but access reports missing", () =>
    Effect.gen(function* () {
      let readPath: string | undefined

      const fs = yield* AppFileSystem.Service
      const response = yield* serveEmbeddedUIEffect(
        "/assets/app.js",
        {
          ...fs,
          existsSafe: () => Effect.die("embedded UI should not rely on filesystem access checks"),
          readFile: (path) => {
            readPath = path
            return path === "/$bunfs/root/assets/app.js"
              ? Effect.succeed(new TextEncoder().encode("console.log('embedded')"))
              : Effect.die(`unexpected embedded UI path: ${path}`)
          },
        },
        { "assets/app.js": "/$bunfs/root/assets/app.js" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(200)
      expect(readPath).toBe("/$bunfs/root/assets/app.js")
      expect(response.headers.get("content-type")).toContain("text/javascript")
      expect(yield* responseText(response)).toBe("console.log('embedded')")
    }),
  )

  it.live("allows embedded UI terminal wasm and theme preload CSP", () =>
    Effect.gen(function* () {
      const script = 'document.documentElement.dataset.theme = "dark"'

      const fs = yield* AppFileSystem.Service
      const response = yield* serveEmbeddedUIEffect(
        "/",
        {
          ...fs,
          readFile: (path) => {
            return path === "/$bunfs/root/index.html"
              ? Effect.succeed(
                  new TextEncoder().encode(
                    `<html><head><script id="oc-theme-preload-script">${script}</script></head></html>`,
                  ),
                )
              : Effect.die(`unexpected embedded UI path: ${path}`)
          },
        },
        { "index.html": "/$bunfs/root/index.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      const csp = response.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
      expect(csp).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`)
      expect(csp).toContain("connect-src * data:")
    }),
  )

  it.live("keeps matched API routes ahead of the UI fallback", () =>
    Effect.gen(function* () {
      const server = routeOrderingApp()
      const response = yield* server.request("/session/ses_nope")

      expect(response.status).toBe(404)
      expect(server.proxiedUrl()).toBeUndefined()
    }),
  )

  it.live("requires server password for the web UI", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({
        password: "secret",
        username: "opencode",
        disableEmbeddedWebUi: true,
      }).request("/")

      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
    }),
  )

  it.live("accepts auth token for the web UI", () =>
    withProxyOnlyUIEffect(
      Effect.gen(function* () {
        const response = yield* uiApp({
          password: "secret",
          username: "opencode",
          disableEmbeddedWebUi: true,
          client: httpClient(new Response("<html>opencode</html>", { headers: { "content-type": "text/html" } })),
        }).request(`/?auth_token=${btoa("opencode:secret")}`)

        expect(response.status).toBe(200)
        expect(yield* responseText(response)).toBe("<html>opencode</html>")
      }),
    ),
  )

  it.live("accepts basic auth for the web UI", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({
        password: "secret",
        username: "opencode",
        disableEmbeddedWebUi: true,
      }).request("/", {
        headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      })

      expect(response.status).toBe(200)
    }),
  )

  // Regression for #25698 (Ope): the browser fetches the PWA manifest and
  // its icons via flows that don't carry app-managed credentials (the
  // `<link rel="manifest">` request is not under page-auth control), so the
  // server returning 401 breaks PWA install. These specific public assets
  // should bypass auth.
  it.live("serves the PWA manifest without auth even when a server password is set", () =>
    Effect.gen(function* () {
      for (const path of ["/site.webmanifest", "/favicon-v3.svg", "/favicon.svg"]) {
        const response = yield* uiApp({
          password: "secret",
          username: "opencode",
          disableEmbeddedWebUi: true,
          client: httpClient(new Response("ok")),
        }).request(path)
        expect(response.status).not.toBe(401)
      }
    }),
  )

  it.live("allows web UI preflight without auth", () =>
    Effect.gen(function* () {
      const response = yield* app({ password: "secret", username: "opencode" }).request("/", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
        },
      })

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    }),
  )
})
