import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@codegoblin/sdk/v2"
import { searchHistory } from "../../../src/cli/cmd/tui/util/history-search"

const user: UserMessage = {
  id: "msg_user",
  sessionID: "ses_history",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "test", modelID: "test" },
}
const assistant: AssistantMessage = {
  id: "msg_reply",
  sessionID: user.sessionID,
  role: "assistant",
  time: { created: 2 },
  agent: "build",
  mode: "",
  modelID: "test",
  providerID: "test",
  parentID: user.id,
  path: { cwd: "/test", root: "/test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const text = (messageID: string, value: string, extra = {}): Part => ({
  id: `prt_${messageID}`,
  messageID,
  sessionID: user.sessionID,
  type: "text",
  text: value,
  ...extra,
})

describe("chat history search", () => {
  test("finds assistant replies as well as user prompts, case-insensitively", () => {
    const results = searchHistory(
      [user, assistant],
      {
        [user.id]: [text(user.id, "Find my project")],
        [assistant.id]: [text(assistant.id, "The UNIQUE answer is here")],
      },
      "unique answer",
    )
    expect(results).toEqual([
      { messageID: assistant.id, role: "assistant", time: 2, preview: "The UNIQUE answer is here" },
    ])
  })
  test("normalizes whitespace and puts the matched passage in the preview", () => {
    const result = searchHistory(
      [assistant],
      { [assistant.id]: [text(assistant.id, `${"prefix ".repeat(100)}hidden\n\nanswer${" suffix".repeat(100)}`)] },
      "hidden answer",
    )[0]
    expect(result.preview).toContain("hidden answer")
    expect(result.preview.startsWith("…")).toBe(true)
    expect(result.preview.length).toBeLessThanOrEqual(162)
  })
  test("does not index synthetic instructions, ignored text or opaque reasoning metadata", () => {
    const parts: Part[] = [
      text(user.id, "synthetic needle", { synthetic: true }),
      text(user.id, "ignored needle", { ignored: true }),
      {
        id: "prt_reason",
        sessionID: user.sessionID,
        messageID: user.id,
        type: "reasoning",
        text: "private needle",
        time: { start: 1 },
        metadata: { openai: { reasoningEncryptedContent: "opaque needle" } },
      },
    ]
    expect(searchHistory([user], { [user.id]: parts }, "needle")).toEqual([])
  })
  test("includes attachment names and completed tool output", () => {
    const parts: Part[] = [
      {
        id: "prt_file",
        messageID: assistant.id,
        sessionID: user.sessionID,
        type: "file",
        mime: "text/plain",
        filename: "architecture-notes.txt",
        url: "file:///test/notes.txt",
      },
      {
        id: "prt_tool",
        messageID: assistant.id,
        sessionID: user.sessionID,
        type: "tool",
        tool: "read",
        callID: "call_1",
        state: {
          status: "completed",
          input: {},
          output: "found old config",
          title: "Read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ]
    expect(searchHistory([assistant], { [assistant.id]: parts }, "architecture")[0].messageID).toBe(assistant.id)
    expect(searchHistory([assistant], { [assistant.id]: parts }, "old config")[0].messageID).toBe(assistant.id)
  })
  test("blank queries browse newest messages first; unmatched queries stay empty", () => {
    const parts = { [user.id]: [text(user.id, "Question")], [assistant.id]: [text(assistant.id, "Answer")] }
    expect(searchHistory([user, assistant], parts, " ").map((item) => item.messageID)).toEqual([assistant.id, user.id])
    expect(searchHistory([user, assistant], parts, "nonexistent")).toEqual([])
  })
})
