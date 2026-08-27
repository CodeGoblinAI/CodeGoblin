/**
 * Smallest thing that works: send one prompt, stream the reply to stdout.
 *
 * This exists before any TUI or web UI on purpose. A UI renders a
 * conversation; there has to be a conversation first. Tools, sessions and
 * the TUI all attach to this.
 *
 *   ANTHROPIC_API_KEY=... bun src/cli/prompt.ts "why is the sky blue"
 */
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages"
import { contentText, type Model } from "@earendil-works/pi-ai"

const prompt = process.argv.slice(2).join(" ").trim()
if (!prompt) {
  console.error('usage: prompt.ts "<your prompt>"')
  process.exit(1)
}

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set.")
  process.exit(1)
}

const model: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 8_192,
  headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
}

for await (const event of stream(model, {
  messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
})) {
  if (event.type === "text_delta") process.stdout.write(event.delta ?? "")
  if (event.type === "done") {
    process.stdout.write("\n")
    if (!contentText(event.message.content)) console.error("(no text returned)")
  }
  if (event.type === "error") {
    console.error("")
    console.error("error:", event.error?.errorMessage ?? event.reason)
    process.exit(1)
  }
}
