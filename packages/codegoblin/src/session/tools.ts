import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ModelID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import * as Log from "@codegoblin/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { loadedToolNames, rankTools } from "./context-policy"
import type { JSONSchema7 } from "@ai-sdk/provider"

const log = Log.create({ service: "session.tools" })
const SEARCH_TOOL = "mcp_tool_search"
const SEARCH_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Describe the external MCP capability needed for the current task in a short phrase",
    },
    tools: {
      type: "array",
      items: { type: "string" },
      description: "Optional exact tool names from the compact capability catalog",
    },
  },
  required: ["query"],
  additionalProperties: false,
}

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
}) {
  using _ = log.time("resolveTools")
  if (!input.model.capabilities.toolcall) return { tools: {}, available: 0, loaded: 0, schemaChars: 0 }

  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const catalog: Array<{
    name: string
    description: string
    source: "builtin" | "mcp"
    definitionChars: number
  }> = []

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    catalog.push({
      name: item.id,
      description: item.description,
      source: "builtin",
      definitionChars: JSON.stringify({ name: item.id, description: item.description, schema }).length,
    })
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, schema)
    catalog.push({
      name: key,
      description: item.description ?? "External MCP capability",
      source: "mcp",
      definitionChars: JSON.stringify({ name: key, description: item.description, schema: transformed }).length,
    })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  const loaded = loadedToolNames(input.messages, SEARCH_TOOL)
  const disabled = Permission.disabled(
    Object.keys(tools),
    Permission.merge(input.agent.permission, input.session.permission ?? []),
  )
  const available = catalog.filter((entry) => tools[entry.name] && !disabled.has(entry.name))
  const builtin = available.filter((entry) => entry.source === "builtin")
  const external = available.filter((entry) => entry.source === "mcp")
  const search = tool({
    description:
      "Search connected MCP servers and load only the external tools relevant to the current task. Built-in filesystem, shell, web, memory, skill, and agent tools are already available and do not require this search.",
    inputSchema: jsonSchema(SEARCH_SCHEMA),
    async execute(args: unknown) {
      const input = args as { query: string; tools?: string[] }
      const selected = rankTools(input.query, external, input.tools)
      return {
        title: `Loaded ${selected.length} capabilities`,
        output: selected.length
          ? [
              "Loaded tools for the next model step:",
              ...selected.map((entry) => `- ${entry.name}: ${entry.description.slice(0, 240)}`),
            ].join("\n")
          : "No matching tools were found. Refine the capability query or answer without tools.",
        metadata: { tools: selected.map((entry) => entry.name) },
      }
    },
  })

  const filtered: Record<string, AITool> = {
    ...Object.fromEntries(builtin.map((entry) => [entry.name, tools[entry.name]])),
    ...(external.length ? { [SEARCH_TOOL]: search } : {}),
    ...Object.fromEntries(
      [...loaded].flatMap((name) => (external.some((entry) => entry.name === name) ? [[name, tools[name]]] : [])),
    ),
  }
  return {
    tools: filtered,
    available: available.length,
    loaded: external.filter((entry) => loaded.has(entry.name)).length,
    schemaChars:
      builtin.reduce((total, entry) => total + entry.definitionChars, 0) +
      (external.length ? JSON.stringify({ name: SEARCH_TOOL, schema: SEARCH_SCHEMA }).length : 0) +
      external.filter((entry) => loaded.has(entry.name)).reduce((total, entry) => total + entry.definitionChars, 0),
  }
})

export * as SessionTools from "./tools"
