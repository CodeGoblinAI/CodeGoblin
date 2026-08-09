import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import * as Log from "@codegoblin/core/util/log"
import { Effect, Option } from "effect"
import { HttpEffect, HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const log = Log.create({ service: "server" })
const MAX_EXTERNAL_IMPORT = 32 * 1024 * 1024

type MarkedInstance = {
  ctx: InstanceContext
  store: InstanceStore.Interface
  bridge: EffectBridge.Shape
}

// Disposal is requested by an endpoint handler, but must run from the outer
// server middleware after the response has been produced. The original Request
// object is the stable handoff key between those two phases.
const disposeAfterResponse = new WeakMap<object, MarkedInstance>()

const mark = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    return { ctx, store: yield* InstanceStore.Service, bridge: yield* EffectBridge.make() }
  })

export const markInstanceForDisposal = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((request, response) =>
      Effect.sync(() => {
        // The response is sent before disposeMiddleware performs the teardown.
        disposeAfterResponse.set(request.source, marked)
        return response
      }),
    )
  })

export const markInstanceForReload = (ctx: InstanceContext, next: InstanceStore.LoadInput) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.as(Effect.uninterruptible(marked.bridge.run(marked.store.reload(next))), response),
    )
  })

export const disposeMiddleware: HttpMiddleware.HttpMiddleware = (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    if (request.method === "POST" && url.pathname === "/external-session/import") {
      const rawLength = request.headers["content-length"]
      const networkRequest = Option.isSome(request.remoteAddress)
      if (networkRequest && request.headers["transfer-encoding"]) {
        return HttpServerResponse.text("Chunked external session imports are not supported.", { status: 413 })
      }
      if (networkRequest && rawLength === undefined) {
        return HttpServerResponse.text("External session imports require Content-Length.", { status: 411 })
      }
      if (rawLength !== undefined && !/^\d+$/.test(rawLength)) {
        return HttpServerResponse.text("External session Content-Length is invalid.", { status: 400 })
      }
      if (rawLength !== undefined && Number(rawLength) > MAX_EXTERNAL_IMPORT) {
        return HttpServerResponse.text("External session exceeds the 32 MB import limit.", { status: 413 })
      }
    }
    const response = yield* effect
    const marked = disposeAfterResponse.get(request.source)
    if (!marked) return response
    disposeAfterResponse.delete(request.source)
    yield* Effect.uninterruptible(marked.bridge.run(marked.store.dispose(marked.ctx))).pipe(
      Effect.catchCause((cause) => Effect.sync(() => log.warn("instance disposal failed", { cause }))),
    )
    return response
  })
