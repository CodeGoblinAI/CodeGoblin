import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import fs from "fs/promises"
import path from "path"
import {
  FetchHttpClient,
  HttpClient,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { AppFileSystem } from "@codegoblin/core/filesystem"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Command } from "@/command"
import * as Observability from "@codegoblin/core/effect/observability"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Ripgrep } from "@/file/ripgrep"
import { Format } from "@/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Installation } from "@/installation"
import { InstanceLayer } from "@/project/instance-layer"
import { Plugin } from "@/plugin"
import { Project } from "@/project/project"
import { ProviderAuth } from "@/provider/auth"
import { ModelsDev } from "@codegoblin/core/models-dev"
import { Provider } from "@/provider/provider"
import { Pty } from "@/pty"
import { PtyTicket } from "@/pty/ticket"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { SyncEvent } from "@/sync"
import { ToolRegistry } from "@/tool/registry"
import { lazy } from "@/util/lazy"
import { Vcs } from "@/project/vcs"
import { Worktree } from "@/worktree"
import { Workspace } from "@/control-plane/workspace"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { PublicApi } from "./public"
import { authorizationLayer, authorizationRouterMiddleware, v2AuthorizationLayer } from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
import { memoryHandlers } from "./handlers/memory"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectRoute, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { v2Handlers } from "./handlers/v2"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer, instanceRouterMiddleware } from "./middleware/instance-context"
import { WorkspaceRouteContext, workspaceRouterMiddleware, workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@codegoblin/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"
import { CodeGoblinImageCommand, type ImageInput } from "@/codegoblin/image-command"
import { CodeGoblinAudioCommand, type AudioVoiceSettings } from "@/codegoblin/audio-command"
import { CodeGoblin3DCommand, type Model3DInputMode } from "@/codegoblin/model3d-command"
import type { Model3DInputImage } from "@/codegoblin/model3d-providers"
import { Market } from "@/codegoblin/market"
import { Process } from "@/util/process"
import { pickCodeGoblinDirectory } from "./pick-directory"
import { isHostOnlyHttpRequest } from "@/server/shared/loopback"

type CodeGoblinImagePersist = {
  sessionID: SessionID
  userMessageID: MessageID
  assistantMessageID: MessageID
  assistantPartID: PartID
  agent: string
  providerID: string
  modelID: string
  variant?: string
  routeDirectory: string
  plannedOutput?: string
}

type CodeGoblinAudioPersist = {
  sessionID: SessionID
  userMessageID: MessageID
  assistantMessageID: MessageID
  assistantPartID: PartID
  agent: string
  providerID: string
  modelID: string
  variant?: string
  routeDirectory: string
  plannedOutput?: string
  voice?: string
  outputFormat?: string
}

type CodeGoblin3DPersist = {
  sessionID: SessionID
  userMessageID: MessageID
  assistantMessageID: MessageID
  assistantPartID: PartID
  agent: string
  providerID: string
  modelID: string
  variant?: string
  routeDirectory: string
  plannedOutput?: string
  inputMode?: Model3DInputMode
  modelVersion?: string
  startedAt: number
  estimatedCredits?: number
}

function codeGoblin3DProgressText(persist: CodeGoblin3DPersist, progressMessage: string) {
  return [
    `CodeGoblin is generating a 3D model with ${persist.providerID}/${persist.modelID}.`,
    persist.inputMode ? `Input mode: ${persist.inputMode}.` : undefined,
    persist.modelVersion ? `Tripo version: ${persist.modelVersion}.` : undefined,
    progressMessage,
    "Usually takes 1–5 minutes.",
    persist.estimatedCredits !== undefined ? `Estimated Tripo credits: ~${persist.estimatedCredits}.` : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

function codeGoblin3DProgressMetadata(persist: CodeGoblin3DPersist, progressMessage: string) {
  return {
    kind: "3d-progress" as const,
    output: persist.plannedOutput,
    provider: persist.providerID,
    model: persist.modelID,
    inputMode: persist.inputMode,
    modelVersion: persist.modelVersion,
    progressMessage,
    credits: persist.estimatedCredits,
    startedAt: persist.startedAt,
  }
}

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes/rawInstanceRoutes: raw instance routes; auth and workspace routing happen as router middleware.
// - instanceApiRoutes: schema routes; auth is declared on each group and workspace context is provided below.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const v2HttpApiAuthLayer = v2AuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const instanceRouterLayer = authorizationRouterMiddleware
  .combine(instanceRouterMiddleware)
  .combine(workspaceRouterMiddleware)
  .layer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal), Layer.provide(ServerAuth.Config.defaultLayer))
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide(instanceRouterLayer),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    mcpHandlers,
    memoryHandlers,
    projectHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    v2Handlers,
    tuiHandlers,
    workspaceHandlers,
  ]),
)

const codeGoblinImageRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const sessionStatus = yield* SessionStatus.Service
    yield* router.add("GET", "/codegoblin/output-image", (request) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        const output = new URL(request.url, "http://localhost").searchParams.get("output") ?? ""
        const image = yield* Effect.promise(async () => {
          try {
            return await readCodeGoblinOutputImage(route.directory, output)
          } catch (error) {
            return {
              ok: false as const,
              message: error instanceof Error ? error.message : "Could not read CodeGoblin output image.",
            }
          }
        })
        if (!image.ok) return HttpServerResponse.jsonUnsafe(image, { status: 404 })
        return HttpServerResponse.raw(image.body, {
          headers: new Headers({
            "cache-control": "no-store",
            "content-type": image.mime,
            "x-content-type-options": "nosniff",
          }),
        })
      }),
    )
    yield* router.add("GET", "/codegoblin/output-audio", (request) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        const output = new URL(request.url, "http://localhost").searchParams.get("output") ?? ""
        const audio = yield* Effect.promise(async () => {
          try {
            return await readCodeGoblinOutputAudio(route.directory, output)
          } catch (error) {
            return {
              ok: false as const,
              message: error instanceof Error ? error.message : "Could not read CodeGoblin output audio.",
            }
          }
        })
        if (!audio.ok) return HttpServerResponse.jsonUnsafe(audio, { status: 404 })
        return HttpServerResponse.raw(audio.body, {
          headers: new Headers({
            "cache-control": "no-store",
            "content-type": audio.mime,
            "x-content-type-options": "nosniff",
          }),
        })
      }),
    )
    yield* router.add("GET", "/codegoblin/output-model3d", (request) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        const output = new URL(request.url, "http://localhost").searchParams.get("output") ?? ""
        const model3d = yield* Effect.promise(async () => {
          try {
            return await readCodeGoblinOutputModel3D(route.directory, output)
          } catch (error) {
            return {
              ok: false as const,
              message: error instanceof Error ? error.message : "Could not read CodeGoblin output 3D model.",
            }
          }
        })
        if (!model3d.ok) return HttpServerResponse.jsonUnsafe(model3d, { status: 404 })
        const headers = new Headers({
          "cache-control": "no-store",
          "content-type": model3d.mime,
          "x-content-type-options": "nosniff",
          "content-disposition": `inline; filename="${model3d.filename}"`,
        })
        return HttpServerResponse.raw(model3d.body, { headers })
      }),
    )
    yield* router.add("GET", "/codegoblin/audio/voices", (request) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        const url = new URL(request.url, "http://localhost")
        const result = yield* Effect.promise(() =>
          CodeGoblinAudioCommand.voices({
            cwd: route.directory,
            keyFile: url.searchParams.get("keyFile") ?? undefined,
            provider: url.searchParams.get("provider") ?? undefined,
          }),
        )
        return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 400 })
      }),
    )
    yield* router.add("GET", "/codegoblin/market", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost")
        const kind = url.searchParams.get("kind") ?? undefined
        const entries = Market.list(kind ? { kind: kind as any } : undefined)
        return HttpServerResponse.jsonUnsafe({ ok: true, entries }, { status: 200 })
      }),
    )
    yield* router.add("POST", "/codegoblin/market/install", (request) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        const text = yield* Effect.orDie(request.text)
        let body: any
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          return HttpServerResponse.jsonUnsafe({ ok: false, message: "Invalid JSON body." }, { status: 400 })
        }
        const id = typeof body?.id === "string" ? body.id : ""
        const entry = id ? Market.get(id) : undefined
        if (!entry) return HttpServerResponse.jsonUnsafe({ ok: false, message: "Unknown market entry." }, { status: 404 })
        const installed = yield* Effect.promise(async () => {
          try {
            const configPath = await Market.addToConfig(entry, route.directory)
            return { ok: true as const, configPath, name: entry.id, config: entry.mcp }
          } catch (error) {
            return { ok: false as const, message: error instanceof Error ? error.message : "Could not add to config." }
          }
        })
        return HttpServerResponse.jsonUnsafe(installed, { status: installed.ok ? 200 : 400 })
      }),
    )
    yield* router.add("POST", "/codegoblin/market/firebase-login", () =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        yield* Effect.sync(() => Market.startFirebaseLogin(route.directory))
        return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 })
      }),
    )
    yield* router.add("POST", "/codegoblin/open-output", (request) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        const text = yield* Effect.orDie(request.text)
        let body: any
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          return HttpServerResponse.jsonUnsafe({ ok: false, message: "Invalid JSON body." }, { status: 400 })
        }

        const output = typeof body?.output === "string" ? body.output : ""
        const mode = body?.mode === "open" || body?.mode === "file" ? body.mode : "folder"
        const opened = yield* Effect.promise(async () => {
          try {
            return await openCodeGoblinOutput(route.directory, output, mode)
          } catch (error) {
            return {
              ok: false as const,
              message: error instanceof Error ? error.message : "Could not open CodeGoblin output.",
            }
          }
        })
        return HttpServerResponse.jsonUnsafe(opened, { status: opened.ok ? 200 : 400 })
      }),
    )
    yield* router.add("POST", "/codegoblin/pick-directory", (request) =>
      Effect.gen(function* () {
        if (!isHostOnlyHttpRequest(request.headers)) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, message: "The folder picker is only available on the local server." },
            { status: 403 },
          )
        }
        const route = yield* WorkspaceRouteContext
        const text = yield* Effect.orDie(request.text)
        let body: any
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          return HttpServerResponse.jsonUnsafe({ ok: false, message: "Invalid JSON body." }, { status: 400 })
        }

        const startDir =
          typeof body?.startDir === "string" && body.startDir.trim() ? body.startDir.trim() : route.directory
        const picked = yield* Effect.promise(() =>
          pickCodeGoblinDirectory({
            title: typeof body?.title === "string" ? body.title : undefined,
            multiple: body?.multiple === true,
            startDir,
          }),
        )
        return HttpServerResponse.jsonUnsafe(picked, { status: picked.ok ? 200 : 400 })
      }),
    )
    yield* router.add("POST", "/codegoblin/audio", (request) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        const text = yield* Effect.orDie(request.text)
        let body: any
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          return HttpServerResponse.jsonUnsafe({ ok: false, message: "Invalid JSON body." }, { status: 400 })
        }

        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : ""
        if (!prompt) return HttpServerResponse.jsonUnsafe({ ok: false, message: "Audio text is required." }, { status: 400 })

        const agent = typeof body?.agent === "string" && body.agent.trim() ? body.agent.trim() : "Agent"
        const variant = typeof body?.variant === "string" ? body.variant : undefined
        const requestProvider = typeof body?.provider === "string" ? body.provider : "elevenlabs"
        const requestModel = typeof body?.model === "string" ? body.model : undefined
        const voiceSettings = parseAudioVoiceSettings(body?.voiceSettings)

        let preview: ReturnType<typeof CodeGoblinAudioCommand.describe>
        try {
          preview = CodeGoblinAudioCommand.describe({
            text: prompt,
            cwd: route.directory,
            provider: requestProvider,
            output: typeof body?.output === "string" ? body.output : undefined,
            model: requestModel,
            voice: typeof body?.voice === "string" ? body.voice : undefined,
            outputFormat: typeof body?.outputFormat === "string" ? body.outputFormat : undefined,
          })
        } catch (error) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, message: error instanceof Error ? error.message : "Audio output path is invalid." },
            { status: 400 },
          )
        }

        const persist = typeof body?.sessionID === "string"
          ? yield* createCodeGoblinAudioMessages({
              session,
              sessionStatus,
              sessionID: SessionID.make(body.sessionID),
              messageID: typeof body?.messageID === "string" ? MessageID.make(body.messageID) : undefined,
              userPartID: typeof body?.userPartID === "string" ? PartID.make(body.userPartID) : undefined,
              assistantMessageID:
                typeof body?.assistantMessageID === "string" ? MessageID.make(body.assistantMessageID) : undefined,
              assistantPartID: typeof body?.assistantPartID === "string" ? PartID.make(body.assistantPartID) : undefined,
              agent,
              providerID: preview.provider,
              modelID: preview.model,
              variant,
              routeDirectory: route.directory,
              input: prompt,
              plannedOutput: preview.output,
              voice: preview.voice,
              outputFormat: preview.outputFormat,
            })
          : undefined

        const result = yield* Effect.promise(async () => {
          try {
            return await CodeGoblinAudioCommand.generate({
              text: prompt,
              cwd: route.directory,
              provider: requestProvider,
              output: typeof body?.output === "string" ? body.output : undefined,
              model: requestModel,
              voice: typeof body?.voice === "string" ? body.voice : undefined,
              outputFormat: typeof body?.outputFormat === "string" ? body.outputFormat : undefined,
              voiceSettings,
              languageCode: typeof body?.languageCode === "string" ? body.languageCode : undefined,
              seed: typeof body?.seed === "number" ? body.seed : undefined,
              applyTextNormalization:
                body?.textNormalization === "auto" || body?.textNormalization === "on" || body?.textNormalization === "off"
                  ? body.textNormalization
                  : undefined,
              applyLanguageTextNormalization:
                typeof body?.languageTextNormalization === "boolean" ? body.languageTextNormalization : undefined,
              keyFile: typeof body?.keyFile === "string" ? body.keyFile : undefined,
            })
          } catch (error) {
            return {
              ok: false,
              message: error instanceof Error ? error.message : "CodeGoblin audio generation failed.",
            }
          }
        })

        if (persist) {
          yield* finishCodeGoblinAudioMessages({ session, sessionStatus, persist, result })
        }

        return HttpServerResponse.jsonUnsafe(persist ? { ...result, sessionID: persist.sessionID } : result, {
          status: result.ok ? 200 : 400,
        })
      }),
    )
    yield* router.add("POST", "/codegoblin/model3d", (request) =>
      Effect.gen(function* () {
        const route = yield* WorkspaceRouteContext
        const text = yield* Effect.orDie(request.text)
        let body: any
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          return HttpServerResponse.jsonUnsafe({ ok: false, message: "Invalid JSON body." }, { status: 400 })
        }

        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : ""
        const inputImages: Model3DInputImage[] = Array.isArray(body?.inputImages)
          ? body.inputImages
              .filter((item: any) => item && typeof item === "object")
              .map((item: any) => ({
                dataUrl: typeof item.dataUrl === "string" ? item.dataUrl : undefined,
                path: typeof item.path === "string" ? item.path : undefined,
                mime: typeof item.mime === "string" ? item.mime : undefined,
                filename: typeof item.filename === "string" ? item.filename : undefined,
              }))
          : []
        if (!prompt && inputImages.length === 0) {
          return HttpServerResponse.jsonUnsafe({ ok: false, message: "3D prompt or image input is required." }, { status: 400 })
        }

        const agent = typeof body?.agent === "string" && body.agent.trim() ? body.agent.trim() : "Agent"
        const variant = typeof body?.variant === "string" ? body.variant : undefined
        const requestProvider = typeof body?.provider === "string" ? body.provider : "tripo"
        const requestModel = typeof body?.model === "string" ? body.model : undefined
        const modelVersion = typeof body?.modelVersion === "string" ? body.modelVersion : variant

        let preview: ReturnType<typeof CodeGoblin3DCommand.describe>
        try {
          preview = CodeGoblin3DCommand.describe({
            prompt,
            cwd: route.directory,
            provider: requestProvider,
            output: typeof body?.output === "string" ? body.output : undefined,
            model: requestModel,
            modelVersion,
            inputImages,
            outputFormat: typeof body?.outputFormat === "string" ? body.outputFormat : undefined,
          })
        } catch (error) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, message: error instanceof Error ? error.message : "3D output path is invalid." },
            { status: 400 },
          )
        }

        const persist = typeof body?.sessionID === "string"
          ? yield* createCodeGoblin3DMessages({
              session,
              sessionStatus,
              sessionID: SessionID.make(body.sessionID),
              messageID: typeof body?.messageID === "string" ? MessageID.make(body.messageID) : undefined,
              userPartID: typeof body?.userPartID === "string" ? PartID.make(body.userPartID) : undefined,
              assistantMessageID:
                typeof body?.assistantMessageID === "string" ? MessageID.make(body.assistantMessageID) : undefined,
              assistantPartID: typeof body?.assistantPartID === "string" ? PartID.make(body.assistantPartID) : undefined,
              agent,
              providerID: preview.provider,
              modelID: preview.model,
              variant,
              routeDirectory: route.directory,
              input: prompt || (preview.inputMode === "image" ? "Generate 3D model from attached image" : ""),
              inputImages,
              plannedOutput: preview.output,
              inputMode: preview.inputMode,
              modelVersion: preview.modelVersion,
            })
          : undefined

        const result = yield* Effect.promise(async () => {
          try {
            return await CodeGoblin3DCommand.generate({
              prompt,
              cwd: route.directory,
              provider: requestProvider,
              output: typeof body?.output === "string" ? body.output : undefined,
              model: requestModel,
              modelVersion,
              inputImages,
              outputFormat: typeof body?.outputFormat === "string" ? body.outputFormat : undefined,
              keyFile: typeof body?.keyFile === "string" ? body.keyFile : undefined,
              onProgress: persist
                ? async (message) => {
                    await Effect.runPromise(
                      updateCodeGoblin3DProgress({
                        session,
                        persist,
                        message,
                        inputMode: preview.inputMode,
                        modelVersion: preview.modelVersion,
                      }),
                    ).catch(() => undefined)
                  }
                : undefined,
            })
          } catch (error) {
            return {
              ok: false,
              message: error instanceof Error ? error.message : "CodeGoblin 3D generation failed.",
            }
          }
        })

        if (persist) {
          yield* finishCodeGoblin3DMessages({ session, sessionStatus, persist, result })
        }

        return HttpServerResponse.jsonUnsafe(persist ? { ...result, sessionID: persist.sessionID } : result, {
          status: result.ok ? 200 : 400,
        })
      }),
    )
    yield* router.add("POST", "/codegoblin/image", (request) =>
      Effect.gen(function* () {
      const route = yield* WorkspaceRouteContext
      const text = yield* Effect.orDie(request.text)
      let body: any
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        return HttpServerResponse.jsonUnsafe({ ok: false, message: "Invalid JSON body." }, { status: 400 })
      }

      const inputImages: ImageInput[] = Array.isArray(body?.inputImages)
        ? body.inputImages
            .filter((item: any) => item && typeof item === "object")
            .map((item: any) => ({
              dataUrl: typeof item.dataUrl === "string" ? item.dataUrl : undefined,
              path: typeof item.path === "string" ? item.path : undefined,
              mime: typeof item.mime === "string" ? item.mime : undefined,
              filename: typeof item.filename === "string" ? item.filename : undefined,
            }))
        : []
      for (const imagePath of imagePathsFromBody(body)) inputImages.push({ path: imagePath })
      const useLastImage = body?.useLastImage === true || body?.lastImage === true
      const replay =
        typeof body?.sessionID === "string" && typeof body?.sourceAssistantMessageID === "string"
          ? yield* codeGoblinImageReplayInput({
              session,
              sessionID: SessionID.make(body.sessionID),
              assistantMessageID: MessageID.make(body.sourceAssistantMessageID),
            })
          : undefined
      if (inputImages.length === 0 && replay?.inputImages.length) inputImages.push(...replay.inputImages)

      const commandInput = typeof body?.input === "string" ? body.input : replay?.input
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : (replay?.prompt ?? "")
      if (!commandInput && !prompt) {
        return HttpServerResponse.jsonUnsafe({ ok: false, message: "Image prompt is required." }, { status: 400 })
      }

      const requestProvider = typeof body?.provider === "string" ? body.provider : replay?.providerID
      const requestModel = typeof body?.model === "string" ? body.model : replay?.modelID
      const agent = typeof body?.agent === "string" && body.agent.trim() ? body.agent.trim() : "Agent"
      const variant = typeof body?.variant === "string" ? body.variant : replay?.variant
      const parsedCommand = commandInput
        ? CodeGoblinImageCommand.parse(commandInput.trimStart().replace(/^\/image\b/, "").trim())
        : undefined
      // Session-aware image continuity: when the user is editing ("make him red") and did not
      // attach an image, reuse the most recent image generated in this chat session. This is more
      // accurate than the global usage.json fallback because it stays scoped to the conversation.
      const editPrompt = parsedCommand?.prompt ?? prompt
      const wantsPreviousImage =
        parsedCommand?.useLastImage ||
        useLastImage ||
        CodeGoblinImageCommand.looksLikeImageEditRequest(editPrompt)
      if (typeof body?.sessionID === "string" && inputImages.length === 0 && wantsPreviousImage) {
        const previous = yield* sessionLastImageOutput({
          session,
          sessionID: SessionID.make(body.sessionID),
        })
        if (previous) inputImages.push({ path: previous })
      }
      let preview: ReturnType<typeof CodeGoblinImageCommand.describe>
      try {
        preview = CodeGoblinImageCommand.describe({
          prompt: parsedCommand?.prompt ?? prompt,
          cwd: route.directory,
          output: parsedCommand?.output ?? (typeof body?.output === "string" ? body.output : undefined),
          provider: parsedCommand?.provider ?? requestProvider,
          model: parsedCommand?.model ?? requestModel,
          useLastImage: parsedCommand?.useLastImage || useLastImage,
        })
      } catch (error) {
        return HttpServerResponse.jsonUnsafe(
          {
            ok: false,
            message: error instanceof Error ? error.message : "Image output path is invalid.",
          },
          { status: 400 },
        )
      }
      const previewProvider = preview.provider ?? requestProvider ?? "image"
      const previewModel = preview.model ?? requestModel ?? "selected-model"
      const persist = typeof body?.sessionID === "string"
        ? yield* createCodeGoblinImageMessages({
            session,
            sessionStatus,
            sessionID: SessionID.make(body.sessionID),
            messageID: typeof body?.messageID === "string" ? MessageID.make(body.messageID) : undefined,
            userPartID: typeof body?.userPartID === "string" ? PartID.make(body.userPartID) : undefined,
            assistantMessageID:
              typeof body?.assistantMessageID === "string" ? MessageID.make(body.assistantMessageID) : undefined,
            assistantPartID: typeof body?.assistantPartID === "string" ? PartID.make(body.assistantPartID) : undefined,
            agent,
            providerID: previewProvider,
            modelID: previewModel,
            variant,
            routeDirectory: route.directory,
            input: commandInput ?? prompt,
            inputImages,
            plannedOutput: preview.output,
          })
        : undefined

      const result = yield* Effect.promise(async () => {
        try {
          return commandInput
            ? await CodeGoblinImageCommand.runSlash({
                input: commandInput,
                cwd: route.directory,
                provider: requestProvider,
                model: requestModel,
                inputImages,
                useLastImage,
                requireImageModel: body?.requireImageModel !== false,
              })
            : await CodeGoblinImageCommand.generate({
                prompt,
                cwd: route.directory,
                output: typeof body?.output === "string" ? body.output : undefined,
                provider: requestProvider,
                model: requestModel,
                keyFile: typeof body?.keyFile === "string" ? body.keyFile : undefined,
                inputImages,
                useLastImage,
                requireImageModel: body?.requireImageModel !== false,
              })
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : "CodeGoblin image generation failed.",
          }
        }
      })

      if (persist) {
        yield* finishCodeGoblinImageMessages({ session, sessionStatus, persist, result })
      }

      return HttpServerResponse.jsonUnsafe(
        persist ? { ...result, sessionID: persist.sessionID } : result,
        { status: result.ok ? 200 : result.requiresImageModel ? 409 : 400 },
      )
      }),
    )
  }),
)

export async function openCodeGoblinOutput(
  root: string,
  output: string,
  mode: "open" | "file" | "folder",
  spawn: typeof Process.spawn = Process.spawn,
) {
  if (!output.trim()) throw new Error("CodeGoblin output path is required.")

  const rootPath = path.resolve(root)
  const target = path.resolve(rootPath, output)
  const rel = path.relative(rootPath, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("CodeGoblin output path must stay inside the current project directory.")
  }

  const stat = await fs.stat(target).catch(() => undefined)
  const isDirectory = stat?.isDirectory() === true
  const openerTarget = mode === "folder" ? (isDirectory ? target : path.dirname(target)) : target
  const openerStat = await fs.stat(openerTarget).catch(() => undefined)
  if (!openerStat) throw new Error("CodeGoblin output does not exist yet.")

  if (process.platform === "win32") {
    const args = mode === "file" && stat && !isDirectory ? [`/select,${target}`] : [openerTarget]
    spawn(["explorer.exe", ...args])
  } else if (process.platform === "darwin") {
    const args = mode === "file" && stat && !isDirectory ? ["-R", target] : [openerTarget]
    spawn(["open", ...args])
  } else {
    spawn(["xdg-open", openerTarget])
  }

  return {
    ok: true as const,
    opened: openerTarget,
  }
}

export async function readCodeGoblinOutputImage(root: string, output: string) {
  const target = resolveCodeGoblinOutputTarget(root, output)
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat || !stat.isFile()) throw new Error("CodeGoblin output image does not exist yet.")

  const mime = imageMimeType(target)
  if (!mime) throw new Error("CodeGoblin output is not a supported image file.")

  return {
    ok: true as const,
    body: await fs.readFile(target),
    mime,
  }
}

export async function readCodeGoblinOutputAudio(root: string, output: string) {
  const target = resolveCodeGoblinOutputTarget(root, output)

  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat || !stat.isFile()) throw new Error("CodeGoblin output audio does not exist yet.")

  return {
    ok: true as const,
    body: await fs.readFile(target),
    mime: audioMimeType(target),
  }
}

export async function readCodeGoblinOutputModel3D(root: string, output: string) {
  const target = resolveCodeGoblinOutputTarget(root, output)

  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat || !stat.isFile()) throw new Error("CodeGoblin output 3D model does not exist yet.")

  return {
    ok: true as const,
    body: await fs.readFile(target),
    mime: model3dMimeType(target),
    filename: path.basename(target),
  }
}

function resolveCodeGoblinOutputTarget(root: string, output: string) {
  const trimmed = output.trim()
  if (!trimmed) throw new Error("CodeGoblin output path is required.")

  const rootPath = path.resolve(root)
  const target = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(rootPath, trimmed)
  const rel = path.relative(rootPath, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("CodeGoblin output path must stay inside the current project directory.")
  }
  return target
}

function imageMimeType(file: string) {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".webp") return "image/webp"
  if (ext === ".gif") return "image/gif"
}

function audioMimeType(file: string) {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".wav") return "audio/wav"
  if (ext === ".pcm") return "application/octet-stream"
  if (ext === ".ulaw" || ext === ".mulaw") return "audio/basic"
  return "audio/mpeg"
}

function model3dMimeType(file: string) {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".glb") return "model/gltf-binary"
  if (ext === ".obj") return "text/plain"
  return "application/octet-stream"
}

function imagePathsFromBody(body: any) {
  return [
    typeof body?.image === "string" ? body.image : undefined,
    typeof body?.imagePath === "string" ? body.imagePath : undefined,
    ...(Array.isArray(body?.images) ? body.images : []),
    ...(Array.isArray(body?.imagePaths) ? body.imagePaths : []),
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function parseAudioVoiceSettings(value: unknown): AudioVoiceSettings | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  const result: AudioVoiceSettings = {
    stability: typeof input.stability === "number" ? input.stability : undefined,
    similarityBoost: typeof input.similarityBoost === "number" ? input.similarityBoost : undefined,
    style: typeof input.style === "number" ? input.style : undefined,
    speed: typeof input.speed === "number" ? input.speed : undefined,
    useSpeakerBoost: typeof input.useSpeakerBoost === "boolean" ? input.useSpeakerBoost : undefined,
  }
  if (Object.values(result).every((item) => item === undefined)) return
  return result
}

function sessionLastImageOutput(input: { session: Session.Interface; sessionID: SessionID; beforeMessageID?: MessageID }) {
  return Effect.gen(function* () {
    const messages = yield* input.session
      .messages({ sessionID: input.sessionID })
      .pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))
    const start = input.beforeMessageID
      ? messages.findIndex((message) => message.info.id === input.beforeMessageID)
      : messages.length
    for (let i = (start < 0 ? messages.length : start) - 1; i >= 0; i--) {
      const parts = messages[i].parts
      for (let j = parts.length - 1; j >= 0; j--) {
        const meta = (parts[j] as { metadata?: { codegoblin?: { kind?: string; output?: string } } }).metadata
          ?.codegoblin
        if (meta?.kind === "image-result" && typeof meta.output === "string" && meta.output.trim()) {
          return meta.output
        }
      }
    }
    return undefined
  })
}

function codeGoblinImageReplayInput(input: {
  session: Session.Interface
  sessionID: SessionID
  assistantMessageID: MessageID
}) {
  return Effect.gen(function* () {
    const messages = yield* input.session
      .messages({ sessionID: input.sessionID })
      .pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))
    const source = messages.find(
      (message) => message.info.id === input.assistantMessageID && message.info.role === "assistant",
    )
    const parentID = (source?.info as { parentID?: MessageID } | undefined)?.parentID
    if (!source || !parentID) return undefined

    const parent = messages.find((message) => message.info.id === parentID)
    const prompt =
      parent?.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim() ?? ""
    if (!prompt) return undefined

    const inputImages =
      parent?.parts
        .filter((part): part is MessageV2.FilePart => part.type === "file")
        .map((part) => filePartImageInput(part))
        .filter((part): part is ImageInput => !!part) ?? []

    if (inputImages.length === 0 && CodeGoblinImageCommand.looksLikeImageEditRequest(prompt)) {
      const previous = yield* sessionLastImageOutput({
        session: input.session,
        sessionID: input.sessionID,
        beforeMessageID: input.assistantMessageID,
      })
      if (previous) inputImages.push({ path: previous })
    }

    return {
      prompt,
      input: prompt.trimStart().startsWith("/image") ? prompt : undefined,
      inputImages,
      providerID: (source.info as { providerID?: string }).providerID,
      modelID: (source.info as { modelID?: string }).modelID,
      variant: (source.info as { variant?: string }).variant,
    }
  })
}

function filePartImageInput(part: MessageV2.FilePart): ImageInput | undefined {
  if (typeof part.url !== "string" || !part.url.startsWith("data:")) return
  if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) return
  return {
    dataUrl: part.url,
    mime: part.mime,
    filename: part.filename,
  }
}

function embeddedImageInput(root: string, image: ImageInput) {
  return Effect.promise(async () => {
    if (image.dataUrl) {
      return {
        url: image.dataUrl,
        mime: image.mime ?? image.dataUrl.match(/^data:([^;,]+)/)?.[1] ?? "image/png",
        filename: image.filename,
      }
    }
    if (!image.path) return undefined
    try {
      const absolute = path.resolve(root, image.path)
      const rel = path.relative(root, absolute)
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
      const mime = imageMimeType(absolute)
      if (!mime) return undefined
      const bytes = await fs.readFile(absolute)
      return { url: `data:${mime};base64,${bytes.toString("base64")}`, mime, filename: image.filename ?? path.basename(absolute) }
    } catch {
      return undefined
    }
  })
}

function createCodeGoblinImageMessages(input: {
  session: Session.Interface
  sessionStatus: SessionStatus.Interface
  sessionID: SessionID
  messageID?: MessageID
  userPartID?: PartID
  assistantMessageID?: MessageID
  assistantPartID?: PartID
  agent: string
  providerID: string
  modelID: string
  variant?: string
  routeDirectory: string
  input: string
  inputImages: ImageInput[]
  plannedOutput?: string
}) {
  return Effect.gen(function* () {
    const userMessageID = input.messageID ?? MessageID.ascending()
    const userPartID = input.userPartID ?? PartID.ascending()
    const assistantMessageID = input.assistantMessageID ?? MessageID.ascending()
    const assistantPartID = input.assistantPartID ?? PartID.ascending()
    const now = Date.now()
    yield* input.sessionStatus.set(input.sessionID, { type: "busy" })
    yield* input.session.updateMessage({
      id: userMessageID,
      role: "user",
      sessionID: input.sessionID,
      time: { created: now },
      agent: input.agent,
      model: {
        providerID: input.providerID,
        modelID: input.modelID,
        variant: input.variant,
      },
    } as MessageV2.User)
    yield* input.session.updatePart({
      id: userPartID,
      sessionID: input.sessionID,
      messageID: userMessageID,
      type: "text",
      text: input.input,
      metadata: {
        codegoblin: {
          kind: "image-request",
        },
      },
    } as MessageV2.TextPart)
    for (const image of input.inputImages) {
      const embedded = yield* embeddedImageInput(input.routeDirectory, image)
      if (!embedded) continue
      yield* input.session.updatePart({
        id: PartID.ascending(),
        sessionID: input.sessionID,
        messageID: userMessageID,
        type: "file",
        mime: embedded.mime,
        filename: embedded.filename,
        url: embedded.url,
      } as MessageV2.FilePart)
    }
    yield* input.session.updateMessage({
      id: assistantMessageID,
      parentID: userMessageID,
      role: "assistant",
      mode: input.agent,
      agent: input.agent,
      variant: input.variant,
      path: { cwd: input.routeDirectory, root: input.routeDirectory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.modelID,
      providerID: input.providerID,
      time: { created: Date.now() },
      sessionID: input.sessionID,
    } as MessageV2.Assistant)
    yield* input.session.updatePart({
      id: assistantPartID,
      sessionID: input.sessionID,
      messageID: assistantMessageID,
      type: "text",
      text: [
        `CodeGoblin is generating an image with ${input.providerID}/${input.modelID}.`,
        input.plannedOutput ? `Saving to: ${input.plannedOutput}` : undefined,
        "This chat message will update when the image finishes.",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        codegoblin: {
          kind: "image-progress",
          output: input.plannedOutput,
          provider: input.providerID,
          model: input.modelID,
        },
      },
    } as MessageV2.TextPart)
    return {
      sessionID: input.sessionID,
      userMessageID,
      assistantMessageID,
      assistantPartID,
      agent: input.agent,
      providerID: input.providerID,
      modelID: input.modelID,
      variant: input.variant,
      routeDirectory: input.routeDirectory,
      plannedOutput: input.plannedOutput,
    } satisfies CodeGoblinImagePersist
  })
}

function finishCodeGoblinImageMessages(input: {
  session: Session.Interface
  sessionStatus: SessionStatus.Interface
  persist: CodeGoblinImagePersist
  result: Awaited<ReturnType<typeof CodeGoblinImageCommand.generate>>
}) {
  return Effect.gen(function* () {
    const providerID = input.result.provider ?? input.persist.providerID
    const modelID = input.result.model ?? input.persist.modelID
    const output = input.result.output ?? input.persist.plannedOutput
    const text = input.result.ok
      ? [
          "Image generated.",
          `Model: ${providerID}/${modelID}`,
          output ? `Saved to: ${output}` : undefined,
          input.result.cost !== undefined ? `Estimated spend: $${input.result.cost.toFixed(4)}.` : undefined,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          `Image generation failed with ${providerID}/${modelID}.`,
          output ? `Planned output: ${output}` : undefined,
          input.result.message,
        ]
          .filter(Boolean)
          .join("\n")

    yield* input.session.updatePart({
      id: input.persist.assistantPartID,
      sessionID: input.persist.sessionID,
      messageID: input.persist.assistantMessageID,
      type: "text",
      text,
      metadata: {
        codegoblin: {
          kind: input.result.ok ? "image-result" : "image-error",
          output,
          provider: providerID,
          model: modelID,
        },
      },
    } as MessageV2.TextPart)
    // Embed the generated image as a file part so it renders inline in chat and accumulates
    // across turns instead of only showing a saved-path string.
    if (input.result.ok && output) {
      const embedded = yield* Effect.promise(async () => {
        try {
          const absolute = path.isAbsolute(output) ? output : path.resolve(input.persist.routeDirectory, output)
          const bytes = await fs.readFile(absolute)
          const ext = path.extname(absolute).toLowerCase()
          const mime =
            ext === ".jpg" || ext === ".jpeg"
              ? "image/jpeg"
              : ext === ".webp"
                ? "image/webp"
                : ext === ".gif"
                  ? "image/gif"
                  : "image/png"
          return { url: `data:${mime};base64,${bytes.toString("base64")}`, mime, filename: path.basename(absolute) }
        } catch {
          return undefined
        }
      })
      if (embedded) {
        yield* input.session.updatePart({
          id: PartID.ascending(),
          sessionID: input.persist.sessionID,
          messageID: input.persist.assistantMessageID,
          type: "file",
          mime: embedded.mime,
          filename: embedded.filename,
          url: embedded.url,
          metadata: {
            codegoblin: {
              kind: "image-output",
              output,
              provider: providerID,
              model: modelID,
            },
          },
        } as MessageV2.FilePart)
      }
    }
    yield* input.session.updateMessage({
      id: input.persist.assistantMessageID,
      parentID: input.persist.userMessageID,
      role: "assistant",
      mode: input.persist.agent,
      agent: input.persist.agent,
      variant: input.persist.variant,
      path: { cwd: input.persist.routeDirectory, root: input.persist.routeDirectory },
      cost: input.result.cost ?? 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID,
      providerID,
      time: { created: Date.now(), completed: Date.now() },
      sessionID: input.persist.sessionID,
    } as MessageV2.Assistant)
    yield* input.sessionStatus.set(input.persist.sessionID, { type: "idle" })
  })
}

function createCodeGoblinAudioMessages(input: {
  session: Session.Interface
  sessionStatus: SessionStatus.Interface
  sessionID: SessionID
  messageID?: MessageID
  userPartID?: PartID
  assistantMessageID?: MessageID
  assistantPartID?: PartID
  agent: string
  providerID: string
  modelID: string
  variant?: string
  routeDirectory: string
  input: string
  plannedOutput?: string
  voice?: string
  outputFormat?: string
}) {
  return Effect.gen(function* () {
    const userMessageID = input.messageID ?? MessageID.ascending()
    const userPartID = input.userPartID ?? PartID.ascending()
    const assistantMessageID = input.assistantMessageID ?? MessageID.ascending()
    const assistantPartID = input.assistantPartID ?? PartID.ascending()
    const now = Date.now()
    yield* input.sessionStatus.set(input.sessionID, { type: "busy" })
    yield* input.session.updateMessage({
      id: userMessageID,
      role: "user",
      sessionID: input.sessionID,
      time: { created: now },
      agent: input.agent,
      model: {
        providerID: input.providerID,
        modelID: input.modelID,
        variant: input.variant,
      },
    } as MessageV2.User)
    yield* input.session.updatePart({
      id: userPartID,
      sessionID: input.sessionID,
      messageID: userMessageID,
      type: "text",
      text: input.input,
      metadata: {
        codegoblin: {
          kind: "audio-request",
        },
      },
    } as MessageV2.TextPart)
    yield* input.session.updateMessage({
      id: assistantMessageID,
      parentID: userMessageID,
      role: "assistant",
      mode: input.agent,
      agent: input.agent,
      variant: input.variant,
      path: { cwd: input.routeDirectory, root: input.routeDirectory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.modelID,
      providerID: input.providerID,
      time: { created: Date.now() },
      sessionID: input.sessionID,
    } as MessageV2.Assistant)
    yield* input.session.updatePart({
      id: assistantPartID,
      sessionID: input.sessionID,
      messageID: assistantMessageID,
      type: "text",
      text: [
        `CodeGoblin is generating audio with ${input.providerID}/${input.modelID}.`,
        input.voice ? `Voice: ${input.voice}` : undefined,
        input.outputFormat ? `Format: ${input.outputFormat}` : undefined,
        input.plannedOutput ? `Saving to: ${input.plannedOutput}` : undefined,
        "This chat message will update when the audio finishes.",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        codegoblin: {
          kind: "audio-progress",
          output: input.plannedOutput,
          provider: input.providerID,
          model: input.modelID,
          voice: input.voice,
          outputFormat: input.outputFormat,
        },
      },
    } as MessageV2.TextPart)
    return {
      sessionID: input.sessionID,
      userMessageID,
      assistantMessageID,
      assistantPartID,
      agent: input.agent,
      providerID: input.providerID,
      modelID: input.modelID,
      variant: input.variant,
      routeDirectory: input.routeDirectory,
      plannedOutput: input.plannedOutput,
      voice: input.voice,
      outputFormat: input.outputFormat,
    } satisfies CodeGoblinAudioPersist
  })
}

function finishCodeGoblinAudioMessages(input: {
  session: Session.Interface
  sessionStatus: SessionStatus.Interface
  persist: CodeGoblinAudioPersist
  result: Awaited<ReturnType<typeof CodeGoblinAudioCommand.generate>>
}) {
  return Effect.gen(function* () {
    const providerID = input.result.provider ?? input.persist.providerID
    const modelID = input.result.model ?? input.persist.modelID
    const output = input.result.output ?? input.persist.plannedOutput
    const voice = input.result.voice ?? input.persist.voice
    const outputFormat = input.result.outputFormat ?? input.persist.outputFormat
    const text = input.result.ok
      ? [
          "Audio generated.",
          `Model: ${providerID}/${modelID}`,
          voice ? `Voice: ${voice}` : undefined,
          outputFormat ? `Format: ${outputFormat}` : undefined,
          output ? `Saved to: ${output}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          `Audio generation failed with ${providerID}/${modelID}.`,
          voice ? `Voice: ${voice}` : undefined,
          output ? `Planned output: ${output}` : undefined,
          input.result.message,
        ]
          .filter(Boolean)
          .join("\n")

    yield* input.session.updatePart({
      id: input.persist.assistantPartID,
      sessionID: input.persist.sessionID,
      messageID: input.persist.assistantMessageID,
      type: "text",
      text,
      metadata: {
        codegoblin: {
          kind: input.result.ok ? "audio-result" : "audio-error",
          output,
          provider: providerID,
          model: modelID,
          voice,
          outputFormat,
        },
      },
    } as MessageV2.TextPart)
    yield* input.session.updateMessage({
      id: input.persist.assistantMessageID,
      parentID: input.persist.userMessageID,
      role: "assistant",
      mode: input.persist.agent,
      agent: input.persist.agent,
      variant: input.persist.variant,
      path: { cwd: input.persist.routeDirectory, root: input.persist.routeDirectory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID,
      providerID,
      time: { created: Date.now(), completed: Date.now() },
      sessionID: input.persist.sessionID,
    } as MessageV2.Assistant)
    yield* input.sessionStatus.set(input.persist.sessionID, { type: "idle" })
  })
}

function createCodeGoblin3DMessages(input: {
  session: Session.Interface
  sessionStatus: SessionStatus.Interface
  sessionID: SessionID
  messageID?: MessageID
  userPartID?: PartID
  assistantMessageID?: MessageID
  assistantPartID?: PartID
  agent: string
  providerID: string
  modelID: string
  variant?: string
  routeDirectory: string
  input: string
  inputImages: Model3DInputImage[]
  plannedOutput?: string
  inputMode?: Model3DInputMode
  modelVersion?: string
}) {
  return Effect.gen(function* () {
    const userMessageID = input.messageID ?? MessageID.ascending()
    const userPartID = input.userPartID ?? PartID.ascending()
    const assistantMessageID = input.assistantMessageID ?? MessageID.ascending()
    const assistantPartID = input.assistantPartID ?? PartID.ascending()
    const now = Date.now()
    yield* input.sessionStatus.set(input.sessionID, { type: "busy" })
    yield* input.session.updateMessage({
      id: userMessageID,
      role: "user",
      sessionID: input.sessionID,
      time: { created: now },
      agent: input.agent,
      model: {
        providerID: input.providerID,
        modelID: input.modelID,
        variant: input.variant,
      },
    } as MessageV2.User)
    yield* input.session.updatePart({
      id: userPartID,
      sessionID: input.sessionID,
      messageID: userMessageID,
      type: "text",
      text: input.input,
      metadata: {
        codegoblin: {
          kind: "3d-request",
          inputMode: input.inputMode,
          modelVersion: input.modelVersion,
        },
      },
    } as MessageV2.TextPart)
    for (const image of input.inputImages) {
      const embedded = yield* embeddedImageInput(input.routeDirectory, image)
      if (!embedded) continue
      yield* input.session.updatePart({
        id: PartID.ascending(),
        sessionID: input.sessionID,
        messageID: userMessageID,
        type: "file",
        mime: embedded.mime,
        filename: embedded.filename,
        url: embedded.url,
      } as MessageV2.FilePart)
    }
    yield* input.session.updateMessage({
      id: assistantMessageID,
      parentID: userMessageID,
      role: "assistant",
      mode: input.agent,
      agent: input.agent,
      variant: input.variant,
      path: { cwd: input.routeDirectory, root: input.routeDirectory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.modelID,
      providerID: input.providerID,
      time: { created: Date.now() },
      sessionID: input.sessionID,
    } as MessageV2.Assistant)
    const startedAt = Date.now()
    const estimatedCredits = CodeGoblin3DCommand.estimateCredits(
      input.providerID,
      input.inputMode,
      input.modelVersion,
    )
    const initialProgress = "Starting Tripo task…"
    yield* input.session.updatePart({
      id: assistantPartID,
      sessionID: input.sessionID,
      messageID: assistantMessageID,
      type: "text",
      text: codeGoblin3DProgressText(
        {
          sessionID: input.sessionID,
          userMessageID,
          assistantMessageID,
          assistantPartID,
          agent: input.agent,
          providerID: input.providerID,
          modelID: input.modelID,
          variant: input.variant,
          routeDirectory: input.routeDirectory,
          plannedOutput: input.plannedOutput,
          inputMode: input.inputMode,
          modelVersion: input.modelVersion,
          startedAt,
          estimatedCredits,
        },
        initialProgress,
      ),
      metadata: {
        codegoblin: codeGoblin3DProgressMetadata(
          {
            sessionID: input.sessionID,
            userMessageID,
            assistantMessageID,
            assistantPartID,
            agent: input.agent,
            providerID: input.providerID,
            modelID: input.modelID,
            variant: input.variant,
            routeDirectory: input.routeDirectory,
            plannedOutput: input.plannedOutput,
            inputMode: input.inputMode,
            modelVersion: input.modelVersion,
            startedAt,
            estimatedCredits,
          },
          initialProgress,
        ),
      },
    } as MessageV2.TextPart)
    return {
      sessionID: input.sessionID,
      userMessageID,
      assistantMessageID,
      assistantPartID,
      agent: input.agent,
      providerID: input.providerID,
      modelID: input.modelID,
      variant: input.variant,
      routeDirectory: input.routeDirectory,
      plannedOutput: input.plannedOutput,
      inputMode: input.inputMode,
      modelVersion: input.modelVersion,
      startedAt,
      estimatedCredits,
    } satisfies CodeGoblin3DPersist
  })
}

function updateCodeGoblin3DProgress(input: {
  session: Session.Interface
  persist: CodeGoblin3DPersist
  message: string
  inputMode?: Model3DInputMode
  modelVersion?: string
}) {
  return Effect.gen(function* () {
    const persist = {
      ...input.persist,
      inputMode: input.inputMode ?? input.persist.inputMode,
      modelVersion: input.modelVersion ?? input.persist.modelVersion,
    }
    yield* input.session.updatePart({
      id: input.persist.assistantPartID,
      sessionID: input.persist.sessionID,
      messageID: input.persist.assistantMessageID,
      type: "text",
      text: codeGoblin3DProgressText(persist, input.message),
      metadata: {
        codegoblin: codeGoblin3DProgressMetadata(persist, input.message),
      },
    } as MessageV2.TextPart)
  })
}

function finishCodeGoblin3DMessages(input: {
  session: Session.Interface
  sessionStatus: SessionStatus.Interface
  persist: CodeGoblin3DPersist
  result: Awaited<ReturnType<typeof CodeGoblin3DCommand.generate>>
}) {
  return Effect.gen(function* () {
    const providerID = input.result.provider ?? input.persist.providerID
    const modelID = input.result.model ?? input.persist.modelID
    const output = input.result.output ?? input.persist.plannedOutput
    const inputMode = input.result.inputMode ?? input.persist.inputMode
    const modelVersion = input.result.modelVersion ?? input.persist.modelVersion
    const credits = input.result.credits ?? input.persist.estimatedCredits
    const text = input.result.ok
      ? [
          "3D model generated.",
          `Model: ${providerID}/${modelID}`,
          inputMode ? `Input mode: ${inputMode}` : undefined,
          modelVersion ? `Tripo version: ${modelVersion}` : undefined,
          output ? `Saved to: ${output}` : undefined,
          credits !== undefined ? `Tripo credits: ~${credits}.` : undefined,
          input.result.taskId ? `Tripo task: ${input.result.taskId}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")
      : [
          `3D generation failed with ${providerID}/${modelID}.`,
          output ? `Planned output: ${output}` : undefined,
          input.result.message,
        ]
          .filter(Boolean)
          .join("\n")

    yield* input.session.updatePart({
      id: input.persist.assistantPartID,
      sessionID: input.persist.sessionID,
      messageID: input.persist.assistantMessageID,
      type: "text",
      text,
      metadata: {
        codegoblin: {
          kind: input.result.ok ? "3d-result" : "3d-error",
          output,
          provider: providerID,
          model: modelID,
          inputMode,
          modelVersion,
          taskId: input.result.taskId,
          credits,
        },
      },
    } as MessageV2.TextPart)
    yield* input.session.updateMessage({
      id: input.persist.assistantMessageID,
      parentID: input.persist.userMessageID,
      role: "assistant",
      mode: input.persist.agent,
      agent: input.persist.agent,
      variant: input.persist.variant,
      path: { cwd: input.persist.routeDirectory, root: input.persist.routeDirectory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID,
      providerID,
      time: { created: Date.now(), completed: Date.now() },
      sessionID: input.persist.sessionID,
    } as MessageV2.Assistant)
    yield* input.sessionStatus.set(input.persist.sessionID, { type: "idle" })
  })
}

const rawInstanceRoutes = Layer.mergeAll(ptyConnectRoute, codeGoblinImageRoute).pipe(Layer.provide(instanceRouterLayer))
const instanceRoutes = Layer.mergeAll(rawInstanceRoutes, instanceApiRoutes).pipe(
  Layer.provide([
    httpApiAuthLayer,
    v2HttpApiAuthLayer,
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    instanceContextLayer,
    schemaErrorLayer,
  ]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

export function createRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  return Layer.mergeAll(rootApiRoutes, eventApiRoutes, instanceRoutes, docRoute, uiRoute).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      Account.defaultLayer,
      Agent.defaultLayer,
      Auth.defaultLayer,
      Command.defaultLayer,
      Config.defaultLayer,
      File.defaultLayer,
      FileWatcher.defaultLayer,
      Format.defaultLayer,
      LSP.defaultLayer,
      Installation.defaultLayer,
      MCP.defaultLayer,
      ModelsDev.defaultLayer,
      Permission.defaultLayer,
      Plugin.defaultLayer,
      Project.defaultLayer,
      ProviderAuth.defaultLayer,
      Provider.defaultLayer,
      Pty.defaultLayer,
      PtyTicket.defaultLayer,
      Question.defaultLayer,
      Ripgrep.defaultLayer,
      RuntimeFlags.defaultLayer,
      Session.defaultLayer,
      SessionCompaction.defaultLayer,
      SessionPrompt.defaultLayer,
      SessionRevert.defaultLayer,
      SessionShare.defaultLayer,
      SessionRunState.defaultLayer,
      SessionStatus.defaultLayer,
      SessionSummary.defaultLayer,
      ShareNext.defaultLayer,
      Snapshot.defaultLayer,
      SyncEvent.defaultLayer,
      EventV2Bridge.defaultLayer,
      Skill.defaultLayer,
      Todo.defaultLayer,
      ToolRegistry.defaultLayer,
      Vcs.defaultLayer,
      Workspace.defaultLayer,
      Worktree.appLayer,
      Bus.layer,
      AppFileSystem.defaultLayer,
      FetchHttpClient.layer,
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(InstanceLayer.layer),
    Layer.provide(Observability.layer),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
