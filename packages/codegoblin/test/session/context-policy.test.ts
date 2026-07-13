import { describe, expect, test } from "bun:test"
import { MessageV2 } from "@/session/message-v2"
import { loadedToolNames, rankTools } from "@/session/context-policy"

describe("context policy", () => {
  test("ranks exact requests before lexical matches", () => {
    const entries = [
      { name: "shell", description: "Run a shell command" },
      { name: "read", description: "Read a file" },
      { name: "notion_search", description: "Search a Notion workspace" },
    ]
    expect(rankTools("find workspace notes", entries, ["notion_search"]).map((entry) => entry.name)).toEqual([
      "notion_search",
    ])
    expect(rankTools("read a file", entries).map((entry) => entry.name)).toEqual(["read"])
  })

  test("does not load tools that only match a broad server name", () => {
    const entries = [
      { name: "notion_API-post-search", description: "Notion search by title" },
      { name: "notion_API-delete-a-block", description: "Notion delete a block" },
      { name: "notion_API-create-a-comment", description: "Notion create a comment" },
    ]
    expect(rankTools("notion search", entries).map((entry) => entry.name)).toEqual(["notion_API-post-search"])
  })

  test("keeps tools selected by capability search sticky", () => {
    const history = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "mcp_tool_search",
            state: { status: "completed", metadata: { tools: ["shell", "read"] } },
          },
          {
            type: "tool",
            tool: "shell",
            state: { status: "completed" },
          },
        ],
      },
    ] as unknown as MessageV2.WithParts[]
    expect([...loadedToolNames(history)]).toEqual(["shell", "read"])
  })
})
