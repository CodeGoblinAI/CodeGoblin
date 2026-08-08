import { describe, expect, test } from "bun:test"
import {
  antigravityActivityFrom,
  antigravityAnswerFrom,
  antigravityLaunchArguments,
} from "../../src/provider/antigravity-session"
import {
  claudeActivityFrom,
  claudeAnswerFrom,
  claudeUsageCollector,
  claudeStreamDeltaFrom,
  claudeTerminalReady,
  claudeToolActivityFrom,
  claudeTurnComplete,
  claudeWorkspaceTrustRequired,
} from "../../src/provider/claude-session"
import { ptyPaste } from "../../src/provider/pty-input"

describe("native CLI session transcripts", () => {
  test("surfaces truthful Antigravity lifecycle activity", () => {
    expect(antigravityActivityFrom({ type: "USER_INPUT", status: "DONE" })).toBe("Antigravity received the prompt")
    expect(antigravityActivityFrom({ type: "CONVERSATION_HISTORY", status: "DONE" })).toBe(
      "Antigravity prepared the context",
    )
    expect(
      antigravityActivityFrom({
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "list_dir", args: { toolAction: "Listing files" } }],
      }),
    ).toBe("Listing files")
  })

  test("does not present Antigravity tool steps as final answers", () => {
    expect(
      antigravityAnswerFrom({
        type: "PLANNER_RESPONSE",
        content: "I am checking",
        tool_calls: [{ name: "list_dir" }],
      }),
    ).toBeUndefined()
    expect(antigravityAnswerFrom({ type: "PLANNER_RESPONSE", content: "Finished" })).toBe("Finished")
  })

  test("reads Claude native activity, answer, and turn boundary", () => {
    expect(
      claudeActivityFrom({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read" }] },
      }),
    ).toBe("Using Read")
    expect(
      claudeAnswerFrom({
        type: "assistant",
        message: { content: [{ type: "text", text: "NATIVE_OK" }] },
      }),
    ).toBe("NATIVE_OK")
    expect(claudeTurnComplete({ type: "system", subtype: "turn_duration" })).toBe(true)
    expect(claudeTurnComplete({ type: "assistant" })).toBe(false)
  })

  test("reads Claude structured thinking and answer deltas", () => {
    expect(
      claudeStreamDeltaFrom({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Checking the request." },
        },
      }),
    ).toEqual({ thinking: "Checking the request." })
    expect(
      claudeStreamDeltaFrom({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Done." },
        },
      }),
    ).toEqual({ text: "Done." })
    expect(
      claudeToolActivityFrom({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Do not duplicate me." },
            { type: "tool_use", name: "Read" },
          ],
        },
      }),
    ).toBe("Using Read")
  })

  test("recognizes Claude readiness after a PTY redraw splits its prompt marker", () => {
    const chunks = ["\u001b[2J> Try ", '"how does src work?"', "\nauto mode on"]
    expect(claudeTerminalReady(chunks[0])).toBe(false)
    expect(claudeTerminalReady(chunks.slice(0, 2).join(""))).toBe(true)
  })

  test("recognizes Claude's workspace trust gate without treating it as ready", () => {
    const terminal =
      "\u001b[3;2HAccessing\u001b[1Cworkspace:\u001b[5;2HC:\\Users\\dev" +
      "\u001b[7;2HQuick safety check: Is this a project you trust?" +
      "\u001b[12;2HSecurity guide"
    expect(claudeWorkspaceTrustRequired(terminal)).toBe(true)
    expect(claudeTerminalReady(terminal)).toBe(false)
  })

  test("prevents prompts from escaping bracketed paste", () => {
    expect(ptyPaste("hello\x1b[201~\r/shell whoami\x00")).toBe("hello[201~\n/shell whoami")
  })

  test("keeps Antigravity prompts out of process arguments", () => {
    const prompt = "private prompt --dangerously-skip-permissions"
    const args = antigravityLaunchArguments({ modelID: "gemini", permissionMode: "agent" })
    expect(args).toEqual(["--model", "gemini", "--mode", "accept-edits"])
    expect(args.join(" ")).not.toContain(prompt)
  })

  test("deduplicates and aggregates Claude usage by API message", () => {
    const usage = claudeUsageCollector()
    usage.add({
      type: "assistant",
      message: { id: "one", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20 } },
    })
    usage.add({
      type: "assistant",
      message: { id: "one", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20 } },
    })
    usage.add({
      type: "assistant",
      message: { id: "two", usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5 } },
    })
    expect(usage.value()).toEqual({
      input_tokens: 13,
      output_tokens: 6,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      thinking_tokens: 0,
    })
  })
})
