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
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Command } from "@/command"
import * as Observability from "@opencode-ai/core/effect/observability"
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
import { ModelsDev } from "@opencode-ai/core/models-dev"
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
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"
import { CodeGoblinImageCommand, type ImageInput } from "@/codegoblin/image-command"
import { Process } from "@/util/process"

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

      const commandInput = typeof body?.input === "string" ? body.input : undefined
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : ""
      if (!commandInput && !prompt) {
        return HttpServerResponse.jsonUnsafe({ ok: false, message: "Image prompt is required." }, { status: 400 })
      }

      const requestProvider = typeof body?.provider === "string" ? body.provider : undefined
      const requestModel = typeof body?.model === "string" ? body.model : undefined
      const agent = typeof body?.agent === "string" && body.agent.trim() ? body.agent.trim() : "Agent"
      const variant = typeof body?.variant === "string" ? body.variant : undefined
      const parsedCommand = commandInput
        ? CodeGoblinImageCommand.parse(commandInput.trimStart().replace(/^\/image\b/, "").trim())
        : undefined
      let preview: ReturnType<typeof CodeGoblinImageCommand.describe>
      try {
        preview = CodeGoblinImageCommand.describe({
          prompt: parsedCommand?.prompt ?? prompt,
          cwd: route.directory,
          output: parsedCommand?.output ?? (typeof body?.output === "string" ? body.output : undefined),
          provider: parsedCommand?.provider ?? requestProvider,
          model: parsedCommand?.model ?? requestModel,
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
      if (!image.dataUrl) continue
      yield* input.session.updatePart({
        id: PartID.ascending(),
        sessionID: input.sessionID,
        messageID: userMessageID,
        type: "file",
        mime: image.mime ?? "image/png",
        filename: image.filename,
        url: image.dataUrl,
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
