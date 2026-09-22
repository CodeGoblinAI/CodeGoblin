/**
 * Smallest thing that works: send one prompt, stream the reply to stdout.
 *
 * This was the first thing built, back when it was the only thing - a hardcoded
 * Anthropic model reached through a third-party client, written to prove a
 * prompt could reach a provider at all. Everything it was scaffolding for has
 * since been built, and built on its own provider layer, so the scaffold was
 * the last place in the repo that depended on anything outside it.
 *
 * It now goes through the same catalogue, key store and stream the TUI and the
 * web UI use. That makes it the shortest path to the wire: when a provider
 * misbehaves, this is one file between a prompt and the response, with no
 * interface in the way.
 *
 *   bun src/cli/prompt.ts "why is the sky blue"
 *   bun src/cli/prompt.ts --model zai/glm-5.3 "why is the sky blue"
 */
import { apiKey, envVariable } from "../core/auth"
import { streamChat } from "../core/chat"
import { defaultSelection, isChatModel, resolveSelection } from "../core/providers"

const argv = process.argv.slice(2)

// --model takes the same "provider/model" string the surfaces use, so what
// works in the picker works here without a second spelling.
let wanted: string | undefined
const words: string[] = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!
  if (arg === "--model" || arg === "-m") {
    wanted = argv[++i]
    continue
  }
  if (arg.startsWith("--model=")) {
    wanted = arg.slice("--model=".length)
    continue
  }
  words.push(arg)
}

const prompt = words.join(" ").trim()
if (!prompt) {
  console.error('usage: prompt.ts [--model provider/model] "<your prompt>"')
  process.exit(1)
}

// An unknown model is a typo, not a reason to answer with something else. The
// surfaces can show a list; here, saying which string failed is the whole help.
const selection = wanted ? resolveSelection(wanted) : defaultSelection()
if (!selection) {
  console.error(`no such model: ${wanted}`)
  process.exit(1)
}

if (!isChatModel(selection)) {
  console.error(`${selection.provider.label} generates media, not conversation - pick a text model.`)
  process.exit(1)
}

const key = apiKey(selection.provider.id)
if (key === undefined) {
  console.error(
    `No API key for ${selection.provider.label}. ` +
      `Set ${envVariable(selection.provider.id)}, or run /connect in the TUI.`,
  )
  process.exit(1)
}

// Ctrl-C should stop the stream rather than leave a request running behind a
// dead terminal.
const stopping = new AbortController()
process.on("SIGINT", () => stopping.abort())

try {
  let answered = false
  for await (const delta of streamChat({
    provider: selection.provider,
    modelId: selection.model.id,
    apiKey: key,
    messages: [{ role: "user", content: prompt }],
    signal: stopping.signal,
  })) {
    answered = true
    process.stdout.write(delta)
  }
  process.stdout.write("\n")
  if (!answered) console.error("(no text returned)")
} catch (error) {
  if (stopping.signal.aborted) {
    process.stdout.write("\n")
    process.exit(130)
  }
  console.error("")
  console.error("error:", error instanceof Error ? error.message : String(error))
  process.exit(1)
}
