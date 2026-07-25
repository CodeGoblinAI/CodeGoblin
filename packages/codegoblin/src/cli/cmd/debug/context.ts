import { EOL } from "os"
import { Cause, Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ToolRegistry } from "@/tool/registry"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Skill } from "@/skill"
import { Permission } from "@/permission"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { ContextReport } from "@/session/context-report"
import { ModelID } from "@/provider/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { effectCmd, fail } from "../../effect-cmd"

/**
 * Reports what a single request costs before any conversation content, using the
 * real prompt sources and real tool schemas for this project. Runs entirely
 * locally — no model call — so the baseline can be tracked without spending
 * tokens to measure it.
 */
export const ContextCommand = effectCmd({
  command: "context",
  describe: "report system prompt and tool schema token cost for this project",
  builder: (yargs) =>
    yargs
      .option("agent", {
        type: "string",
        default: "build",
        description: "Agent to measure",
      })
      .option("tools", {
        type: "number",
        default: 15,
        description: "How many tool schemas to list",
      })
      .option("json", {
        type: "boolean",
        default: false,
        description: "Emit the raw report as JSON",
      }),
  handler: Effect.fn("Cli.debug.context")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return

    const agent = yield* Agent.Service.use((svc) => svc.get(args.agent))
    if (!agent) return yield* fail(`Agent ${args.agent} not found`, 1)

    const provider = yield* Provider.Service
    const model =
      agent.model ??
      (yield* provider.defaultModel().pipe(
        Effect.matchCauseEffect({
          onSuccess: Effect.succeed,
          onFailure: (cause) => {
            const error = Cause.squash(cause) as Provider.DefaultModelError
            if (error instanceof Provider.ModelNotFoundError) {
              return fail(`Model not found: ${error.providerID}/${error.modelID}`)
            }
            if (error instanceof Provider.NoModelsError) return fail(`No models found for provider ${error.providerID}`)
            return fail("No providers found")
          },
        }),
      ))

    const resolved = yield* provider
      .getModel(model.providerID, model.modelID)
      .pipe(Effect.catch((error) => fail(`Model not found: ${error.providerID}/${error.modelID}`)))
    const instruction = yield* Instruction.Service
    const skill = yield* Skill.Service

    const instructions = yield* instruction.system().pipe(Effect.orDie)
    const env = SystemPrompt.environmentText({
      model: resolved,
      directory: ctx.directory,
      worktree: ctx.worktree,
      git: ctx.project.vcs === "git",
    })
    const skills = Permission.disabled(["skill"], agent.permission).has("skill")
      ? undefined
      : SystemPrompt.skillsText(yield* skill.available(agent))

    // Mirrors the ordering in session/prompt.ts: static base prompt first, then
    // session-stable sources. Nothing turn-volatile belongs in here — if a
    // `turn` block shows up, the prefix is being poisoned again.
    const blocks: ContextReport.SystemBlock[] = [
      {
        label: "base prompt",
        text: agent.prompt ?? SystemPrompt.provider(resolved).join("\n"),
        stability: "static",
      },
      ...instructions.map((text) => ({ label: "instructions", text, stability: "session" as const })),
      ...(skills ? [{ label: "skills", text: skills, stability: "session" as const }] : []),
      { label: "env", text: env, stability: "session" as const },
    ]

    // Same construction session/tools.ts uses, so the numbers line up with what
    // actually goes on the wire for builtin tools.
    const registry = yield* ToolRegistry.Service
    const entries = yield* registry.tools({
      modelID: ModelID.make(resolved.api.id),
      providerID: resolved.providerID,
      agent,
    })
    const disabled = Permission.disabled(
      entries.map((item) => item.id),
      agent.permission,
    )
    const tools: Record<string, unknown> = {}
    for (const item of entries) {
      if (disabled.has(item.id)) continue
      tools[item.id] = {
        description: item.description,
        inputSchema: ProviderTransform.schema(resolved, ToolJsonSchema.fromTool(item)),
      }
    }

    const report = ContextReport.buildContextReport({ system: blocks, tools })

    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + EOL)
      return
    }

    const all = yield* skill.all()
    process.stdout.write(
      [
        `agent:  ${agent.name}`,
        `model:  ${resolved.providerID}/${resolved.api.id}`,
        `skills: ${all.length} discovered`,
        `tools:  ${Object.keys(tools).length} builtin schemas sent (${disabled.size} disabled)`,
        "",
        ContextReport.format(report, { tools: args.tools }),
        "",
        "Note: MCP tool schemas are deferred behind mcp_tool_search and are not",
        "counted here until the model loads them.",
      ].join(EOL) + EOL,
    )
  }),
})
