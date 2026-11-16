import { authHeaders, kindOf, type Provider } from "./providers"
import { isLocalChat, verifyLocalModel } from "./local-provider"
import { localRuntime, type Lease } from "./local-runtime"
import { cliCompletion } from "./cli-completion"
import { endedUntold } from "./jobs"
import { TOOL_SCHEMA, runTool, isConcurrent, redactSecrets, resolveReadable, fitResult } from "./tools"
import { imageTypeOf, readImageFile } from "./mention"

/** Waits before sending a failed request again: three tries, about twelve seconds in all. */
const RETRY_WAITS = [1000, 3000, 8000]
/** Answers that mean "not now" rather than "no": too many requests, and the server-side failures. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529])

/** How many identical results in a turn before the model is told it is repeating itself. */
const REPEAT_NUDGES = [3, 5, 8]
import { storedSecrets } from "./auth"
import { checkpointEvery, spendLimitPerPrompt } from "./config"
import { configuredInstructions } from "./instructions"
import type { Permissions } from "./permission"
import { shouldCompact, planCompaction, applyCompaction, boundSummaryInput, SUMMARY_PROMPT, estimateTokens, priceOf, costOf, formatSpend, readUsage, usageSince, type StreamUsage } from "./context"
import { sessionFacts } from "./session-facts"
import { parseTodos, type Todo } from "./todo"
import type { History } from "./undo"

/**
 * Tools from outside the built-in table - MCP servers today. The loop offers
 * them next to its own and routes a call back; consent is the same for both.
 */
import { QUESTION_TOOL, answerText, parseQuestion, type AskUser } from "./question"

export type ExtraTools = {
  schema(): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[]
  has(name: string): boolean
  call(name: string, args: unknown): Promise<string>
}

/** Background subagents: tools to start and collect them, and a wait for any still out. */
export type Subagents = ExtraTools & {
  /** Waits for subagents not yet reported, and returns their results - or nothing when there are none. */
  settle(signal?: AbortSignal): Promise<string | undefined>
}

export type Role = "user" | "assistant" | "system" | "tool"
export type ToolCall = { id: string; name: string; args: string }

/**
 * A picture attached to a message.
 *
 * Held as a data URL because that is what the wire wants and what a session
 * file can hold: a path would go stale the moment the file moved, and a
 * conversation reopened next week should still show what it was asked about.
 */
export type Attachment = { name: string; dataUrl: string }

export type Message = {
  role: Role
  /** What the model sees. For a user message with @-mentions this includes the attached files. */
  content: string
  /** What the human sees, when that differs - a message with its mentions still written as @paths. */
  display?: string
  /** Images attached to this message, for models that can be shown one. */
  images?: Attachment[]
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  /** The reasoning behind a message that made tool calls; sent back only to providers with `replayReasoning`. */
  reasoning?: string
  /** UI/session metadata; never forwarded as an API field. */
  stopped?: boolean
  /** A command the person ran with `!`; shown as its output, not as something they said. Metadata only. */
  typed?: boolean
  /** When it was written, for /timestamps. Metadata only - never sent. */
  at?: number
}

function continuationContent(message: Message) {
  return message.stopped ? message.content + "\n\n[This answer was stopped by the user.]" : message.content
}

export const LOCAL_CHAT_SYSTEM = "You are CodeGoblin, a helpful assistant. Answer concisely. You cannot run tools or modify files in local chat mode."

/** The exact conversation a tool-free local model receives. Shared with context metering. */
export function localChatMessages(messages: Message[], instructions?: string): Message[] {
  return [
    { role: "system", content: [LOCAL_CHAT_SYSTEM, instructions].filter(Boolean).join("\n\n") },
    ...messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message): Message => ({ role: message.role, content: continuationContent(message) })),
  ]
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  /**
   * `id` is the model's own tool-call id, carried through so a surface can
   * match a result to the row that asked for it. Without it a surface has to
   * assume the end of one tool follows the start of it, which only held while
   * tools ran strictly one after another.
   */
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_end"; id: string; name: string; result: string }
  /**
   * `by` says whose decision it was - a rule in codegoblin.jsonc, plan mode, or
   * the person asked - so a surface never labels a command a rule stopped as
   * one somebody refused. `rule` is the pattern, when it was a rule.
   */
  | { type: "tool_denied"; id: string; name: string; by: "rule" | "plan" | "user"; rule?: string }
  | { type: "compacted"; before: number; after: number }
  /** The provider was busy or unreachable; the request is being sent again after `waitMs`. */
  | { type: "retry"; attempt: number; of: number; waitMs: number; reason: string }
  | { type: "plan"; todos: Todo[] }
  /** `cached` is the part of `input` the provider read from its prompt cache, when it says. */
  | { type: "spend"; input: number; output: number; cached?: number; /** What the provider says the request cost, when it says. */ dollars?: number }
  /**
   * The loop ran out of turns with the model still calling tools.
   *
   * Without this the surfaces could not tell a finished answer from an
   * abandoned one: the loop fell out of its bounds and emitted the same
   * turn_end a normal reply ends with, so work that stopped half-done looked
   * exactly like work that was complete.
   */
  | { type: "limit"; turns: number }
  | { type: "output_limit" }
  /**
   * An autonomy checkpoint was reached: this many tool calls in one turn.
   *
   * `stopped` says how the person answered - the turn ended here, or it
   * carries on and asks again after another full window of calls.
   */
  | { type: "checkpoint"; toolCalls: number; stopped: boolean; /** Set when it was the spend limit that paused the turn, in dollars. */ spent?: number }
  /** Subagents finished and their results were handed to the model, which carries on. */
  | { type: "subagents_collected" }
  /**
   * CG-Next's own llama-server is loading the picked model, then has it.
   * A cold load takes from a second to a minute, which is too long to say nothing.
   */
  | { type: "runtime"; model: string; state: "loading" | "ready"; ms?: number; gpu?: boolean }
  | { type: "turn_end" }

/**
 * The chat endpoint, or a refusal.
 *
 * Image, audio and 3D providers sit in the same catalogue but have nowhere
 * to send a conversation. The surfaces route those prompts to their own
 * generators before it gets this far; this is the backstop, and it says what
 * happened rather than posting to undefined.
 */
function chatEndpoint(provider: Provider, modelId?: string): string {
  // A provider can both chat and draw (OpenAI): its image model still has no conversation.
  const model = modelId ? provider.models.find((entry) => entry.id === modelId) : undefined
  if (!provider.baseUrl || (model && kindOf(model) !== "text")) {
    throw new Error(
      `${provider.label} generates media, not conversation - pick a text model with /model to chat`,
    )
  }
  return provider.baseUrl
}

/**
 * Only the fields the API knows about.
 *
 * Messages carry a display copy for the UI, and providers that validate their
 * input reject unknown keys outright - so the wire gets the wire fields.
 */
const wire = (messages: Message[], memory?: string, images = false, instructions?: string, replayReasoning = false) => {
  const sent: ReturnType<typeof shape>[] = []
  // Pictures a tool opened. A tool result is text on this wire, so they follow the step's results as one
  // message the model can look at.
  let opened: Attachment[] = []
  const flush = () => {
    if (!opened.length) return
    const names = opened.map((image) => image.name).join(", ")
    sent.push({
      role: "user",
      content: [
        { type: "text", text: `(${names}: ${opened.length === 1 ? "the image" : "the images"} read_file opened, shown here so you can see ${opened.length === 1 ? "it" : "them"} directly)` },
        ...opened.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
      ],
      tool_calls: undefined,
      tool_call_id: undefined,
    })
    opened = []
  }
  for (const raw of messages) {
    if (raw.role === "tool") {
      if (images && raw.images?.length) opened.push(...raw.images)
      sent.push(shape({ ...raw, images: undefined }, images))
      continue
    }
    flush()
    // The reasoning goes back as its own field, only to providers that want it, and only beside tool calls.
    const extra = replayReasoning && raw.reasoning && raw.tool_calls?.length ? { reasoning_content: raw.reasoning } : {}
    sent.push({ ...shape(raw, images), ...extra })
  }
  flush()
  return finish(sent, memory, instructions)
}

const shape = (message: Message, images: boolean) => {
    const { role, images: attached, tool_calls, tool_call_id } = message
    const content = continuationContent(message)
    // A message with pictures becomes the multimodal shape, which is the only
    // form a vision model reads them in. Without this the attachment simply
    // did not reach the model: content was always a plain string.
    if (images && attached?.length) {
      return {
        role,
        content: [
          ...(content ? [{ type: "text", text: content }] : []),
          // Named, and said to be in view: with tools on hand DeepSeek V4.1 Flash went off to open "@swatch.png"
          // with the shell (three approvals) instead of looking at the picture it had been sent.
          { type: "text", text: `(${attached.map((image) => image.name).join(", ")}: attached below as ${attached.length === 1 ? "an image" : "images"} you can see directly - no need to open the file)` },
          ...attached.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
        ],
        tool_calls,
        tool_call_id,
      }
    }

    // Attached to a model that cannot see - say so rather than leave the model
    // answering a question about a picture it was never sent.
    if (!images && attached?.length) {
      const names = attached.map((image) => image.name).join(", ")
      return {
        role,
        content:
          content +
          String.fromCharCode(10, 10) +
          `(${attached.length === 1 ? "an image was" : "images were"} attached - ${names} - ` +
          `but this model cannot see images, so it has not been sent)`,
        tool_calls,
        tool_call_id,
      }
    }

    return { role, content, tool_calls, tool_call_id }
}

const finish = (sent: { role: Role; content: unknown; tool_calls?: unknown; tool_call_id?: string }[], memory?: string, instructions?: string) => {

  // Memory rides along with the system prompt rather than being stored in
  // the conversation: it is read fresh every turn, so forgetting something
  // takes effect immediately instead of lingering in old messages.
  const first = sent[0]
  const extra = [instructions, memory].filter(Boolean).join(String.fromCharCode(10, 10))
  if (extra && first?.role === "system" && typeof first.content === "string") {
    sent[0] = { ...first, content: first.content + String.fromCharCode(10, 10) + extra }
  }
  if (extra && first?.role !== "system") sent.unshift({ role: "system", content: extra, tool_calls: undefined, tool_call_id: undefined })
  return sent
}

/** What the model is told while planning, next to the other instructions. */
const PLANNING = [
  "Planning is on. Look around as much as you need - read files, search, run read-only commands -",
  "then reply with a concrete, numbered plan: what you would change, where, and how you would",
  "check it. Do not change anything yet; the user decides when the plan is carried out.",
].join(" ")

/**
 * What the model is told when it calls a subagent tool that is not on offer -
 * usually from memory, after a boosted request. "unknown tool" made a real
 * model decide its earlier, genuine subagent report had been invented, and
 * tell the user not to trust it.
 */
const STOPPED_BEFORE_ANSWER = "stopped by the user before this finished - it may not have run, or run only part way"

/**
 * Gives every tool call without a result one saying it was stopped. Stopping a
 * turn while a tool ran left the call unanswered, and providers reject a
 * conversation like that - so the message after a stop failed too.
 */
export function closeOpenCalls(messages: Message[]) {
  for (let at = 0; at < messages.length; at++) {
    const calls = messages[at]!.role === "assistant" ? (messages[at]!.tool_calls ?? []) : []
    if (!calls.length) continue
    let end = at + 1
    const answered = new Set<string>()
    while (end < messages.length && messages[end]!.role === "tool") answered.add(String(messages[end++]!.tool_call_id))
    const missing = calls
      .filter((call) => !answered.has(call.id))
      .map((call): Message => ({ role: "tool", tool_call_id: call.id, content: STOPPED_BEFORE_ANSWER }))
    messages.splice(end, 0, ...missing)
    at = end + missing.length - 1
  }
}

const SUBAGENTS_OFF =
  "error: subagents are not available for this request - the user turns them on with /boost. " +
  "Do the work with your own tools. Results you had from subagents earlier in this conversation were real."

/** Tools that change files. Planning does not offer them, so the model never tries one and gets refused. */
const CHANGES_FILES = new Set(["write_file", "edit_file", "apply_patch"])

/**
 * Models trained on apply_patch get it, as in the fork: GPT-5-era and Codex
 * models, not the open-weight gpt-oss or GPT-4. The others never see it.
 */
export function usesPatch(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return (id.includes("gpt-") || id.includes("codex")) && !id.includes("oss") && !id.includes("gpt-4")
}

function offeredTools(input: { modelId?: string; permissions?: Permissions; extraTools?: ExtraTools; subagents?: Subagents; tools?: string[]; askUser?: AskUser }) {
  const planning = input.permissions?.planning === true
  // The job tools go with the shell that starts the jobs.
  const listed = (asked: string): boolean => { const name = asked === "job_output" || asked === "job_stop" ? "shell" : asked; return listedExactly(name) }
  const listedExactly = (name: string) => (name === "apply_patch" ? Boolean(input.modelId && usesPatch(input.modelId)) && (!input.tools || input.tools.includes("edit_file") || input.tools.includes("apply_patch")) : !input.tools || input.tools.includes(name))
  const own = TOOL_SCHEMA.filter((tool) => listed(tool.function.name) && !(planning && CHANGES_FILES.has(tool.function.name)))
  // MCP tools can do anything, and nothing says which of them only read.
  const mcp = planning || !listed("mcp") ? [] : (input.extraTools?.schema() ?? [])
  // Only where someone is there to answer.
  const asking = input.askUser && listed("question") ? [QUESTION_TOOL] : []
  return [...own, ...asking, ...mcp, ...(input.subagents?.schema() ?? [])]
}

/**
 * The agent loop.
 *
 * Streams a completion; if the model asked for tools, runs them, appends the
 * results, and streams again. Repeats until it answers without calling a tool,
 * until the model answers without calling a tool - or until maxTurns, when a caller sets one.
 *
 * Tool calls arrive in fragments like text does - the name in one chunk, the
 * arguments across several - so they are accumulated by index before running.
 *
 * A model CG-Next serves itself is leased for the whole run, compaction and
 * subagents included, so another conversation cannot swap it out mid-answer.
 */
export async function* runAgent(input: AgentInput): AsyncGenerator<AgentEvent, void, unknown> {
  if (!input.provider.runtime) return yield* runTurns(input)
  const started = Date.now()
  const loading = !localRuntime.serving(input.modelId)
  if (loading) yield { type: "runtime", model: input.modelId, state: "loading" }
  let lease: Lease
  try {
    lease = await localRuntime.acquire(input.modelId, { signal: input.signal })
  } catch (error) {
    // Stopped while loading: the same marker a stop anywhere else leaves.
    if (input.signal?.aborted) input.messages.push({ role: "assistant", content: "", stopped: true })
    throw error
  }
  try {
    const status = localRuntime.status()
    if (loading) yield { type: "runtime", model: input.modelId, state: "ready", ms: Date.now() - started, gpu: status.state !== "stopped" && status.gpu }
    const key = lease.key
    yield* runTurns({
      ...input,
      provider: { ...input.provider, baseUrl: lease.baseUrl + "/chat/completions", localTools: lease.tools, auth: () => ({ authorization: "Bearer " + key }) },
    })
  } finally {
    lease.release()
  }
}

type AgentInput = Parameters<typeof runTurns>[0]

async function* runTurns(input: {
  provider: Provider
  modelId: string
  apiKey: string
  messages: Message[]
  root: string
  contextWindow?: number
  /** Whether this model can be shown a picture; see acceptsImages in providers. */
  images?: boolean
  /** Waits (ms) before each retry of a failed request; empty turns retrying off. Default: 1 s, 3 s, 8 s. */
  retryWaits?: number[]
  permissions?: Permissions
  /** What is remembered, folded into the system prompt for this request. */
  memory?: string
  /** More for the system prompt, read fresh each request - the index of skills today. */
  instructions?: string
  /** Given a turn, keeps the previous state of every file the turn writes. */
  history?: History
  /**
   * Where compaction puts the messages it replaces, before replacing them.
   * Surfaces pass the session archive; without one, compaction still works
   * but the replaced words exist only in the summary.
   */
  archive?: (messages: Message[]) => Promise<void>
  /** MCP tools, offered next to the built-in ones and asked about the same way. */
  extraTools?: ExtraTools
  /** Subagents this conversation can start in the background - offered even while planning. */
  subagents?: Subagents
  /** The built-in tools this agent may use, by name; "mcp" allows MCP tools. Everything when unset. */
  tools?: string[]
  /** Asks the person a question and waits; the question tool is offered only when this is set. */
  askUser?: AskUser
  /**
   * How hard the model should think, for models that take it.
   *
   * The caller decides whether this model understands the field - a provider
   * handed a reasoning_effort it does not know can reject the whole request,
   * so the loop only forwards what it is given.
   */
  effort?: string
  /**
   * Pause and ask to continue after this many tool calls in the turn.
   *
   * An explicit value wins (which is what tests use); otherwise the config
   * file is read fresh, so an edit applies to the next turn. 0 means never.
   */
  checkpoint?: number
  /** Pause and ask after this many dollars on one prompt; config's autonomy.spend when unset, 0 never. */
  spendLimit?: number
  maxTurns?: number
  signal?: AbortSignal
  /** Given what a running tool prints, as it prints it (a shell command's output), by the call's id. For showing, not for the model. */
  onToolOutput?: (id: string, text: string) => void
  /** An internal inference transport seam; never exposed through UI/config. Consent stays here. */
  completion?: typeof cliCompletion
}): AsyncGenerator<AgentEvent, void, unknown> {
  // No limit unless a caller sets one. A fixed cap stopped real work part way
  // - a plan carried out, checked, and then cut off before the model could say
  // so - and a model that has finished says so by answering without a tool.
  // A person stops a turn that is going nowhere; that is what stop is for.
  const maxTurns = input.maxTurns ?? Number.POSITIVE_INFINITY
  const configured = configuredInstructions(input.root)
  const localChat = isLocalChat(input.provider, input.modelId)
  // Facts about the session ride with the instructions, so the model can answer
  // "which model / what effort are you?" from what it was given.
  const facts = localChat ? undefined : sessionFacts({ provider: input.provider, modelId: input.modelId, effort: input.effort, mode: input.permissions?.mode, root: input.root })
  input = { ...input, instructions: [configured, input.instructions, facts].filter(Boolean).join("\n\n") || undefined }
  const price = input.provider.models.find((model) => model.id === input.modelId)?.price
  const priced = Boolean(price && (price.input > 0 || price.output > 0))
  let spentThisPrompt = 0
  let nextSpendCheck = 0
  let partial = ""
  let checkpointStopped = false
  try {
  await verifyLocalModel(input.provider, input.modelId, input.signal)

  // A turn stopped while its tools ran left calls with no answer.
  closeOpenCalls(input.messages)

  // A tool outside this agent's list is refused without being run or asked
  // about. A model can name a tool it was never offered.
  const usable = (name: string) =>
    !localChat && (!input.tools ||
    input.tools.includes(name) ||
    (name === "apply_patch" && input.tools.includes("edit_file")) ||
    (name.startsWith("mcp__") && input.tools.includes("mcp")) ||
    Boolean(input.subagents?.has(name)))

  // Compact before the first request rather than after a failure: the
  // provider rejects an oversized conversation outright.
  const windowOf = () => input.checkpoint ?? checkpointEvery()
  // Autonomy guardrail, on by default (autonomy.checkpoint): every tool call this
  // turn counts - spawns too, because a task call is a tool call in this turn -
  // and at each full window the person is asked whether to keep going. 0 means never.
  let toolCallsThisTurn = 0
  let nextCheckpoint = windowOf()
  // The same call with the same answer, how many times this turn: a model going round in a circle.
  const repeats = new Map<string, number>()
  for (let turn = 0; turn < maxTurns; turn++) {
    if (input.signal?.aborted) return
    if (turn > 0) await verifyLocalModel(input.provider, input.modelId, input.signal)
    // CLI serialization/tools have their own bounded transport budget, not a claimed model window.
    const contextWindow = input.provider.cli ? Math.min(input.contextWindow || 100_000, 100_000) : input.contextWindow
    const cliSize = input.provider.cli ? estimateTokens(JSON.stringify({ messages: wire(input.messages, input.memory, false, input.instructions), tools: offeredTools(input) })) : 0
    if (contextWindow && (input.provider.cli ? cliSize > contextWindow * 0.75 : shouldCompact(localChat ? localChatMessages(input.messages, configured) : input.messages, contextWindow))) {
    const before = input.messages.length
    const plan = planCompaction(input.messages, contextWindow)
    if (plan.summarise.length) {
      // Only what fits the window is sent to be condensed; all of it is archived.
      const { messages: condensing } = boundSummaryInput(plan.summarise, contextWindow)
      const summary = input.provider.cli ? yield* summariseCli(input, condensing) : yield* summarise(input, condensing)
      // Archived before history is replaced: if saving fails, the turn fails
      // with the conversation intact rather than silently losing its past.
      await input.archive?.(plan.summarise)
      input.messages.splice(0, input.messages.length, ...applyCompaction(plan.system, summary, plan.keep))
      yield { type: "compacted", before, after: input.messages.length }
    }
  }

    let text = ""
    let reasoning = ""
    let outputLimited = false
    const calls = new Map<number, ToolCall>()
    if (input.provider.cli) {
      for await (const event of (input.completion ?? cliCompletion)({
        cli: input.provider.cli, apiKey: input.apiKey, modelId: input.modelId, signal: input.signal, effort: input.effort, tools: offeredTools(input),
        messages: wire(input.messages, input.memory, false,
          [input.instructions, input.permissions?.planning ? PLANNING : undefined].filter(Boolean).join("\n\n")),
      })) {
        if (event.type === "calls") { event.calls.forEach((call, index) => calls.set(index, call)); continue }
        if (event.type === "text") { text += event.delta; partial = text }
        if (event.type === "output_limit") { outputLimited = true; continue }
        if (event.type === "spend" && priced) spentThisPrompt += costOf(event, price) ?? 0
        yield event
      }
    } else {
    // Worked out once, outside the retry: a model with nowhere to send a message is an error, not a busy signal.
    const endpoint = chatEndpoint(input.provider, input.modelId)
    const send = () => fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(input.provider, input.apiKey) },
      body: JSON.stringify({
        model: input.modelId,
        ...(input.provider.localThinking !== undefined ? { chat_template_kwargs: { enable_thinking: input.provider.localThinking } } : {}),
        messages: localChat ? localChatMessages(input.messages, configured) : wire(
          input.messages,
          input.memory,
          input.images,
          [input.instructions, input.permissions?.planning ? PLANNING : undefined].filter(Boolean).join(String.fromCharCode(10, 10)) ||
            undefined,
          input.provider.replayReasoning,
        ),
        tools: localChat ? undefined : offeredTools(input),
        stream: true,
        // llama.cpp omits usage on streams unless asked; without this a local
        // turn never records spend and /usage reads "nothing yet" forever.
        // Local-only: hosted providers get nothing they did not ask for.
        ...(input.provider.local || input.provider.usageOnStream ? { stream_options: { include_usage: true } } : {}),
        ...(input.effort ? { reasoning_effort: input.effort } : {}),
      }),
      signal: input.signal,
    }).catch((error: unknown) => {
      if (!input.provider.local || input.signal?.aborted) throw error
      if (input.provider.runtime) throw new Error(localRuntime.status().lastError ?? `CG-Next's local model server stopped answering; /local shows its state.`, { cause: error })
      throw new Error(`Cannot reach the local model server at ${input.provider.baseUrl}. Start the server, wait until it is ready, and try again. CG-Next starts servers only for installed models under Local.`, { cause: error })
    })

    // A provider that is busy or briefly broken is asked again, a few times, with a wait between. Without
    // this a single 429 in the middle of an hour's work ended the turn. Only before any of the answer has
    // arrived, never for a local server (its failures are not passing ones), and never after a stop.
    let response: Response
    const waits = input.retryWaits ?? RETRY_WAITS
    for (let attempt = 0; ; attempt++) {
      let failure: unknown
      let got: Response | undefined
      try { got = await send() } catch (error) { failure = error }
      const again = !input.provider.local && !input.signal?.aborted && attempt < waits.length && (got ? RETRY_STATUS.has(got.status) : true)
      if (!again) {
        if (!got) throw failure
        response = got
        break
      }
      const asked = got ? Number(got.headers.get("retry-after")) : NaN
      const waitMs = Math.min(30_000, Number.isFinite(asked) && asked > 0 ? asked * 1000 : waits[attempt]!)
      await got?.body?.cancel().catch(() => {})
      yield { type: "retry", attempt: attempt + 1, of: waits.length, waitMs, reason: got ? "HTTP " + got.status : "no connection" }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs)
        function done() { clearTimeout(timer); input.signal?.removeEventListener("abort", done); resolve() }
        input.signal?.addEventListener("abort", done, { once: true })
      })
      if (input.signal?.aborted) return
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "")
      throw new Error(`${input.provider.label} returned ${response.status}. ${detail.slice(0, 300)}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    // What has been counted of this one answer's usage so far (see usageSince).
    let counted: StreamUsage | undefined

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const payload = trimmed.slice(5).trim()
        if (payload === "[DONE]") break
        let chunk: any
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }

        // Usage rides on the final chunk of the stream, after the deltas
        // stop. Throwing it away is why nothing could say what a session had
        // cost - the one number people want from a tool that spends their
        // money.
        const reported = readUsage(chunk?.usage, input.provider.reportsCost)
        const spend = reported && usageSince(reported, counted)
        if (reported) counted = reported
        if (spend) {
          if (priced) spentThisPrompt += costOf(spend, price) ?? 0
          yield { type: "spend", ...spend }
        }

        const delta = chunk?.choices?.[0]?.delta
        if (chunk?.choices?.[0]?.finish_reason === "length") outputLimited = true

        // Reasoning models stream their thinking on a separate field. The
        // name is not standardised, so accept the variants seen in the wild.
        const thought = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking
        if (typeof thought === "string" && thought) {
          reasoning += thought
          yield { type: "thinking", delta: thought }
        }

        if (typeof delta?.content === "string" && delta.content) {
          text += delta.content
          partial = text
          yield { type: "text", delta: delta.content }
        }

        for (const part of delta?.tool_calls ?? []) {
          const index = part.index ?? 0
          const existing = calls.get(index) ?? { id: "", name: "", args: "" }
          if (part.id) existing.id = part.id
          if (part.function?.name) existing.name = part.function.name
          if (part.function?.arguments) existing.args += part.function.arguments
          calls.set(index, existing)
        }
      }
    }

    }
    if (input.signal?.aborted) return
    if (outputLimited) {
      // Truncated tool arguments are not executable requests.
      input.messages.push({ role: "assistant", content: text + "\n\n[The model reached its output-token limit; this answer is unfinished.]" })
      partial = ""
      yield { type: "output_limit" }
      yield { type: "turn_end" }
      return
    }

    if (calls.size === 0) {
      input.messages.push({ role: "assistant", content: text })
      partial = ""
      // Subagents still working, or finished with results the model never
      // collected, are waited for and handed over, and the model carries on
      // with them - so an answer never ends with its own work still out.
      const collected = await input.subagents?.settle(input.signal)
      if (collected && !input.signal?.aborted) {
        input.messages.push({ role: "user", content: collected, display: "results from background subagents" })
        yield { type: "subagents_collected" }
        continue
      }
      yield { type: "turn_end" }
      return
    }

    const pending = [...calls.values()].filter((call) => call.name)
    input.messages.push({
      role: "assistant",
      content: text,
      ...(reasoning ? { reasoning } : {}),
      tool_calls: pending.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.args || "{}" },
      })),
    })
    partial = ""

    // Consent runs first, in the order asked, one at a time. A permission
    // prompt is a question put to a person; two of them arriving at once is
    // not something a person can answer. Only the work afterwards overlaps.
    const decided: {
      call: ToolCall
      args: unknown
      allowed: boolean
      refusal?: { reason: string; by: "rule" | "plan" | "user"; rule?: string }
    }[] = []
    for (const call of pending) {
      if (input.signal?.aborted) return
      let args: unknown = {}
      try {
        args = JSON.parse(call.args || "{}")
      } catch {
        // Leave args empty; the tool reports the failure itself.
      }
      // Consent happens here rather than inside the tool, so every surface
      // gets the same prompt and the model still receives a normal tool
      // result when it is refused. The verdict carries its reason, so a call
      // stopped by a rule in codegoblin.jsonc says which rule rather than
      // telling the model the user refused something they were never asked.
      const verdict = input.permissions && usable(call.name) ? await input.permissions.decide(call.name, call.args) : undefined
      if (!verdict || verdict.allowed) decided.push({ call, args, allowed: true })
      else decided.push({ call, args, allowed: false, refusal: verdict })
    }

    // Every chip opens at once, so a turn that asked for four reads looks like
    // four reads rather than one that keeps changing its name.
    for (const { call } of decided) {
      yield { type: "tool_start", id: call.id, name: call.name, args: call.args }
    }

    // An MCP tool is not concurrent - nothing says what it touches - and it is
    // outside undo, because what it changes is not a file this loop can see.
    const run = (entry: { call: ToolCall; args: unknown }) =>
      !usable(entry.call.name)
        ? Promise.resolve(`error: ${entry.call.name} is not available to this agent`)
        : (entry.call.name === "task" || entry.call.name === "task_result") && !input.subagents
          ? Promise.resolve(SUBAGENTS_OFF)
          : entry.call.name === "question"
          ? (input.askUser
              ? (async () => {
                  try {
                    const question = parseQuestion(entry.args)
                    return answerText(question, await input.askUser!(question, input.signal))
                  } catch (error) {
                    return "error: " + (error instanceof Error ? error.message : String(error))
                  }
                })()
              : Promise.resolve("error: there is no one to ask here - decide, or say what you need in your reply"))
          : input.subagents?.has(entry.call.name)
          ? input.subagents.call(entry.call.name, entry.args)
          : input.extraTools?.has(entry.call.name)
            ? input.extraTools.call(entry.call.name, entry.args)
            : entry.call.name === "read_file" && imageTypeOf(String((entry.args as { path?: unknown })?.path ?? ""))
            ? openImage(entry.call.id, String((entry.args as { path: unknown }).path))
            : runTool(
                entry.call.name,
                entry.args,
                input.root,
                async (relative) => {
                  await input.history?.record(input.root, relative)
                },
                input.signal,
                input.onToolOutput ? (text) => input.onToolOutput!(entry.call.id, text) : undefined,
              )

    // read_file on a picture: the model is shown it if it can see, and told plainly if it cannot. Read as
    // text it was unreadable bytes, and a model that got those went looking through the file's metadata.
    const pictures = new Map<string, Attachment>()
    const openImage = async (id: string, target: string) => {
      try {
        const file = await readImageFile(resolveReadable(input.root, target), target)
        if (!file) return "error: not a file: " + target
        const what = `${target} is ${file.type.replace("image/", "").toUpperCase()} image${file.size ? `, ${file.size.width}x${file.size.height}` : ""}, ${Math.max(1, Math.round(file.bytes / 1024))} KB.`
        if (!file.image) return what + " It is too large to show you (the limit is 5 MB)."
        if (!input.images) return what + " You cannot see images, so you cannot know what it shows: say so, and that a model with vision (chosen with /model) can look at it. Do not guess from its metadata."
        pictures.set(id, file.image)
        return what + " It is shown to you in the next message: look at it there."
      } catch (error) {
        return "error: " + (error instanceof Error ? error.message : String(error))
      }
    }

    // Reads overlap; everything else keeps its order. Four file reads used to
    // cost four round trips end to end for no reason - they do not touch each
    // other, and nothing about them depends on which finishes first.
    const results = new Map<string, string>()
    const runnable = decided.filter((entry) => entry.allowed)
    await Promise.all(
      runnable
        .filter((entry) => isConcurrent(entry.call.name))
        .map(async (entry) => {
          results.set(entry.call.id, await run(entry))
        }),
    )
    for (const entry of runnable.filter((each) => !isConcurrent(each.call.name))) {
      if (input.signal?.aborted) return
      results.set(entry.call.id, await run(entry))
    }

    // Stored keys never reach the model, the saved conversation or the screen,
    // whichever tool printed them - a shell `type auth.json` did once.
    const secrets = storedSecrets()
    for (const [id, result] of results) results.set(id, await fitResult(redactSecrets(result, secrets), id))

    // A nudge, never a block: the third, fifth and eighth time a call comes back exactly as before, the result
    // says so. Counted on the answer as well as the arguments, so re-running the tests after an edit - same
    // command, different outcome - is left alone.
    for (const { call, allowed } of decided) {
      const result = results.get(call.id)
      if (!allowed || result === undefined) continue
      const key = call.name + "\u0000" + call.args + "\u0000" + result
      const seen = (repeats.get(key) ?? 0) + 1
      repeats.set(key, seen)
      if (REPEAT_NUDGES.includes(seen)) {
        results.set(call.id, result + `\n\n(This is the ${seen === 3 ? "third" : seen === 5 ? "fifth" : "eighth"} time ${call.name} was called with these arguments and gave this same result. Calling it again will not change it: use what it says, try something different, or say what is in the way.)`)
      }
    }

    // A background job that ended since the model last heard of it is said on the last result of this round.
    const last = [...decided].reverse().find((entry) => entry.allowed && results.has(entry.call.id))
    if (last) {
      const ended = endedUntold(input.root)
      if (ended) results.set(last.call.id, results.get(last.call.id) + "\n\n" + redactSecrets(ended, secrets))
    }

    // Reported in the order the model asked for them, whatever order they
    // finished in, so a transcript reads the same way twice.
    for (const { call, args, allowed, refusal } of decided) {
      if (!allowed) {
        const reason = refusal?.reason ?? "refused by the user"
        input.messages.push({ role: "tool", tool_call_id: call.id, content: reason })
        yield {
          type: "tool_denied",
          id: call.id,
          name: call.name,
          by: refusal?.by ?? "user",
          ...(refusal?.rule ? { rule: refusal.rule } : {}),
        }
        yield { type: "tool_end", id: call.id, name: call.name, result: reason }
        continue
      }

      const result = results.get(call.id) ?? "not run"
      // The plan is state the surfaces render, not just a tool result.
      if (call.name === "todo_write") {
        yield { type: "plan", todos: parseTodos((args as Record<string, unknown>)?.todos) }
      }
      const picture = pictures.get(call.id)
      input.messages.push({ role: "tool", tool_call_id: call.id, content: result, ...(picture ? { images: [picture] } : {}) })
      yield { type: "tool_end", id: call.id, name: call.name, result }
    }

    // Reached a checkpoint window: ask whether this turn may keep going.
    // Without permissions there is nobody to ask, so the turn carries on;
    // stopping the turn ends it the way a stop does, with the work so far kept.
    toolCallsThisTurn += pending.length
    const every = windowOf()
    if (every <= 0) nextCheckpoint = 0
    else {
      if (nextCheckpoint <= 0) nextCheckpoint = every
      if (input.permissions && !input.permissions.checkpointsOff && toolCallsThisTurn >= nextCheckpoint) {
        if (input.signal?.aborted) return
        const stopped =
          (await input.permissions.checkpoint(toolCallsThisTurn, every)) === "stop" || input.signal?.aborted === true
        yield { type: "checkpoint", toolCalls: toolCallsThisTurn, stopped }
        if (stopped) {
          checkpointStopped = true
          yield { type: "turn_end" }
          return
        }
        nextCheckpoint = toolCallsThisTurn + every
      }
    }

    // The money brake, next to the call-count one. Calls are a poor proxy for
    // cost: each step resends the whole conversation, so late steps cost far
    // more than early ones. Asked again each time the spend passes another
    // full limit; "for this session" turns both brakes off.
    const limit = input.spendLimit ?? spendLimitPerPrompt()
    if (priced && limit > 0 && input.permissions && !input.permissions.checkpointsOff) {
      if (nextSpendCheck <= 0) nextSpendCheck = limit
      if (spentThisPrompt >= nextSpendCheck) {
        if (input.signal?.aborted) return
        const spent = formatSpend({ input: 0, output: 0, dollars: spentThisPrompt })
        const stopped = (await input.permissions.spendCheckpoint(spent)) === "stop" || input.signal?.aborted === true
        yield { type: "checkpoint", toolCalls: toolCallsThisTurn, stopped, spent: spentThisPrompt }
        if (stopped) {
          checkpointStopped = true
          yield { type: "turn_end" }
          return
        }
        while (nextSpendCheck <= spentThisPrompt) nextSpendCheck += limit
      }
    }
  }

  // Falling out of the loop means the last turn still asked for tools. Every
  // other way out returns, so this is the only path that reaches here.
  yield { type: "limit", turns: maxTurns }
  yield { type: "turn_end" }
  } finally {
    if (input.signal?.aborted || checkpointStopped) {
      // Partial tool-call fragments are not saved as executable proposals.
      // Already-committed calls get ordinary stopped results before the marker.
      closeOpenCalls(input.messages)
      input.messages.push({ role: "assistant", content: partial, stopped: true })
    }
  }
}

async function* summariseCli(input: {
  provider: Provider; modelId: string; apiKey: string; signal?: AbortSignal; completion?: typeof cliCompletion
}, messages: Message[]): AsyncGenerator<AgentEvent, string> {
  let text = ""
  for await (const event of (input.completion ?? cliCompletion)({
    cli: input.provider.cli, apiKey: input.apiKey, modelId: input.modelId, signal: input.signal, tools: [],
    messages: wire([...messages, { role: "user", content: SUMMARY_PROMPT }]),
  })) {
    if (event.type === "text") text += event.delta
    if (event.type === "spend") yield event
    if (event.type === "output_limit") throw new Error("CLI summary reached its output limit; history was not replaced")
  }
  input.signal?.throwIfAborted()
  if (!text.trim()) throw new Error("CLI returned an empty summary; history was not replaced")
  return text.trim()
}


/**
 * Compacts a conversation outside a turn: /compact, and the idle compaction.
 *
 * The same summary the loop writes when the window fills - made by the model,
 * with everything it replaces archived first. `keepWindow` plans against a
 * smaller window than the model's, to keep less word for word. With `strict`
 * a summary that cannot be had leaves the conversation exactly as it was,
 * which is what an unattended compaction must do.
 */
export async function* compactConversation(input: {
  provider: Provider; modelId: string; apiKey: string; messages: Message[]; contextWindow: number
  keepWindow?: number; strict?: boolean; signal?: AbortSignal; archive?: (replaced: Message[]) => Promise<void>
}): AsyncGenerator<AgentEvent, boolean> {
  const window = Math.min(input.contextWindow, input.keepWindow ?? input.contextWindow)
  const plan = planCompaction(input.messages, window)
  if (!plan.summarise.length) return false
  const before = input.messages.length
  // What is condensed is bounded by the model's real window, not the smaller one planned against.
  const { messages: condensing } = boundSummaryInput(plan.summarise, input.contextWindow)
  const summary = input.provider.cli ? yield* summariseCli(input, condensing) : yield* summarise(input, condensing, input.strict)
  input.signal?.throwIfAborted()
  await input.archive?.(plan.summarise)
  input.messages.splice(0, input.messages.length, ...applyCompaction(plan.system, summary, plan.keep))
  yield { type: "compacted", before, after: input.messages.length }
  return true
}

/**
 * One non-streaming call to summarise the older half of a conversation.
 * Failure is not fatal: a crude fallback beats losing the turn.
 *
 * Its usage is spend like any other request - on a long conversation the
 * summary is often the biggest call of the turn - and Stop reaches it, since
 * condensing a long history can take a minute.
 */
async function* summarise(
  input: { provider: Provider; modelId: string; apiKey: string; signal?: AbortSignal },
  messages: Message[],
  /** Throw rather than fall back to the crude list - for a compaction nobody is waiting on. */
  strict = false,
): AsyncGenerator<AgentEvent, string> {
  try {
    const response = await fetch(chatEndpoint(input.provider, input.modelId), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(input.provider, input.apiKey) },
      body: JSON.stringify({
        model: input.modelId,
        messages: wire([...messages, { role: "user", content: SUMMARY_PROMPT }]),
        stream: false,
      }),
      signal: input.signal,
    })
    if (!response.ok) throw new Error(String(response.status))
    const body = (await response.json()) as any
    const used = readUsage(body?.usage, input.provider.reportsCost)
    if (used) yield { type: "spend", ...used }
    const text = body?.choices?.[0]?.message?.content
    if (typeof text === "string" && text.trim()) return text.trim()
    throw new Error("empty summary")
  } catch (error) {
    // A stop is a stop, not a reason to invent a summary and carry on.
    if (input.signal?.aborted || strict) throw error
    return messages
      .filter((message) => message.role === "user")
      .map((message) => "- " + message.content.slice(0, 160))
      .join(String.fromCharCode(10))
  }
}
