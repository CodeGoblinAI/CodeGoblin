import { expect, test } from "bun:test"
import { CLAUDE_CHAT_FLAGS, ClaudeStream, claudeChat, claudeCommand } from "../src/core/claude-cli"
import { isChatModel, resolveSelection, acceptsImages, effortFor } from "../src/core/providers"
import { apiKey } from "../src/core/auth"

const init = { type: "system", subtype: "init", tools: [], mcp_servers: [] }
const result = { type: "result", subtype: "success", result: "Hello", usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 2, output_tokens: 4 } }
const parse = (parser: ClaudeStream, value: unknown) => parser.parse(JSON.stringify(value))

test("supported Claude effort reaches the actual CLI argument boundary", () => {
  for (const level of ["low", "medium", "high"] as const) {
    for (const id of ["default", "sonnet", "opus"]) {
      const effort = effortFor(resolveSelection("claude-code/" + id)!.model, level)
      expect(effort).toBe(level)
      expect(claudeCommand("claude", CLAUDE_CHAT_FLAGS, { modelId: id, effort }).slice(-2)).toEqual(["--effort", level])
    }
  }
  expect(effortFor(resolveSelection("claude-code/haiku")!.model, "high")).toBeUndefined()
  expect(claudeCommand("claude", CLAUDE_CHAT_FLAGS, { modelId: "sonnet" })).not.toContain("--effort")
})

test("Claude connector is text-only chat without a copied API key", () => {
  const selection = resolveSelection("claude-code/haiku")!
  expect(selection.model.contextWindow).toBe(0)
  expect(isChatModel(selection)).toBe(true)
  expect(acceptsImages(selection)).toBe(false)
  expect(selection.provider.baseUrl).toBeUndefined()
  expect(apiKey("claude-code")).toBe("")
  expect(CLAUDE_CHAT_FLAGS).toContain("--safe-mode")
  expect(CLAUDE_CHAT_FLAGS[CLAUDE_CHAT_FLAGS.indexOf("--tools") + 1]).toBe("")
  expect(CLAUDE_CHAT_FLAGS).toContain("--strict-mcp-config")
  expect(CLAUDE_CHAT_FLAGS).toContain("--no-session-persistence")
})

test("streams deltas once, counts cached tokens, and ignores unrelated CLI events", () => {
  const parser = new ClaudeStream()
  expect(parse(parser, init)).toEqual([])
  expect(parse(parser, { type: "rate_limit_event" })).toEqual([])
  expect(parse(parser, { type: "stream_event", event: { delta: { type: "text_delta", text: "Hello" } } })).toEqual([{ type: "text", delta: "Hello" }])
  expect(parse(parser, { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } })).toEqual([])
  expect(parse(parser, result)).toEqual([{ type: "spend", input: 15, output: 4 }])
  expect(parser.finished).toBe(true)
  expect(parser.text).toBe("Hello")
})

test("result fallback and truncated-answer notice", () => {
  const parser = new ClaudeStream()
  parse(parser, init)
  expect(parse(parser, { ...result, stop_reason: "max_tokens" })).toEqual([
    { type: "text", delta: "Hello" }, { type: "spend", input: 15, output: 4 }, { type: "output_limit" },
  ])
})

test("errors and unsafe native tools fail closed", () => {
  for (const value of [
    { ...init, tools: ["Bash"] }, { ...init, mcp_servers: [{ name: "unexpected" }] },
    { ...init, tools: undefined },
    { type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in" },
    result,
    { type: "stream_event", event: { delta: { type: "text_delta", text: "unsafe" } } },
  ]) expect(() => parse(new ClaudeStream(), value)).toThrow()
  const parser = new ClaudeStream()
  parse(parser, init)
  expect(() => parse(parser, { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use" } } })).toThrow("Unexpected native tool")
  expect(() => parser.parse("not JSON")).toThrow()
})

test("already-cancelled calls never launch a CLI", async () => {
  const signal = AbortSignal.abort()
  await expect(claudeChat({ modelId: "haiku", messages: [], signal }).next()).rejects.toThrow()
})

test("structured mode permits only the pure formatter and ignores prose outside the final schema", () => {
  const parser = new ClaudeStream(true)
  parse(parser, { ...init, tools: ["StructuredOutput"] })
  expect(parse(parser, { type: "stream_event", event: { delta: { type: "text_delta", text: "Preamble that must not be control JSON" } } })).toEqual([])
  expect(parse(parser, { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "StructuredOutput" } } })).toEqual([])
  const output = { text: "Safe reply", calls: [] }
  expect(parse(parser, { ...result, structured_output: output })[0]).toEqual({ type: "text", delta: JSON.stringify(output) })
  expect(() => parse(new ClaudeStream(true), { ...init, tools: ["StructuredOutput", "Bash"] })).toThrow()
  const bad = new ClaudeStream(true)
  parse(bad, init)
  expect(() => parse(bad, { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "write_file" } } })).toThrow()
  expect(() => parse(bad, result)).toThrow("structured response")
})
