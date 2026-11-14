import { afterEach, describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { streamText, wrapLanguageModel, type ModelMessage } from "ai"
import { reasoningRecovery } from "../../src/session/llm/reasoning-recovery"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => Promise.all(servers.splice(0).map((server) => server.stop(true))))

function fixture(responses: Response[]) {
  const requests: { body: Record<string, unknown>; authorization: string | null }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ body: await request.json(), authorization: request.headers.get("authorization") })
      return responses.shift() ?? new Response("unexpected request", { status: 418 })
    },
  })
  servers.push(server)
  const recoveries: number[] = []
  const model = wrapLanguageModel({
    model: createOpenAI({ baseURL: `${server.url}v1`, apiKey: "local-fixture-only" }).responses("muse-spark-test"),
    middleware: reasoningRecovery(() => recoveries.push(requests.length)),
  })
  const run = async (messages: ModelMessage[]) => {
    const result = streamText({
      model,
      messages,
      maxRetries: 0,
      onError() {},
      providerOptions: { openai: { store: false } },
    })
    const text: string[] = []
    for await (const event of result.fullStream) {
      if (event.type === "error") throw event.error
      if (event.type === "text-delta") text.push(event.text)
    }
    return text.join("")
  }
  return { run, requests, recoveries }
}

function rejected(message = "reasoning `encrypted_content` has expired", status = 400) {
  return Response.json({ error: { message, type: "invalid_request_error", code: "invalid_request" } }, { status })
}

function accepted() {
  const chunks = [
    { type: "response.created", response: { id: "resp_test", created_at: 1, model: "muse-spark-test" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_test", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", item_id: "msg_test", delta: "Still in the same chat." },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: null, output_tokens_details: null },
      },
    },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

function history(): ModelMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "Remember this conversation and attachment." },
        { type: "image", image: new URL("https://example.com/reference.png") },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Visible reasoning summary.",
          providerOptions: { openai: { itemId: "rs_old", reasoningEncryptedContent: "expired-fixture" } },
        },
        { type: "reasoning", text: "Second summary.", providerOptions: { openai: { itemId: "rs_old" } } },
        { type: "text", text: "Previous answer." },
        { type: "tool-call", toolCallId: "call_old", toolName: "read", input: { path: "notes.txt" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_old", toolName: "read", output: { type: "text", value: "notes" } },
      ],
    },
    { role: "user", content: "Continue here." },
  ]
}

describe("expired reasoning recovery", () => {
  test("retries the same provider once, preserving visible history, attachments and tool pairs", async () => {
    const local = fixture([rejected(), accepted()])
    const messages = history()
    const original = JSON.stringify(messages)
    expect(await local.run(messages)).toBe("Still in the same chat.")
    expect(JSON.stringify(messages)).toBe(original)
    expect(local.requests).toHaveLength(2)
    expect(local.recoveries).toEqual([1])
    const first = local.requests[0]
    const retry = local.requests[1]
    expect(first.authorization).toBe("Bearer local-fixture-only")
    expect(retry.authorization).toBe(first.authorization)
    expect(retry.body.model).toBe(first.body.model)
    expect(first.body.input).toContainEqual(
      expect.objectContaining({ type: "reasoning", encrypted_content: "expired-fixture" }),
    )
    expect(retry.body.input).not.toContainEqual(expect.objectContaining({ type: "reasoning" }))
    expect(JSON.stringify(retry.body)).not.toContain("rs_old")
    const visible = (first.body.input as { type?: string }[]).filter((item) => item.type !== "reasoning")
    expect(retry.body.input).toEqual(expect.arrayContaining(visible))
    expect(JSON.stringify(retry.body)).toContain("Visible reasoning summary.")
    expect(JSON.stringify(retry.body)).toContain("Second summary.")
  })

  test("skips rejected old state on later turns but still sends fresh encrypted reasoning", async () => {
    const local = fixture([rejected(), accepted(), accepted()])
    await local.run(history())
    await local.run([
      ...history(),
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "", providerOptions: { openai: { reasoningEncryptedContent: "fresh-fixture" } } },
        ],
      },
      { role: "user", content: "Another turn." },
    ])
    expect(local.requests).toHaveLength(3)
    expect(local.recoveries).toHaveLength(1)
    expect(JSON.stringify(local.requests[2].body)).not.toContain("expired-fixture")
    expect(local.requests[2].body.input).toContainEqual(
      expect.objectContaining({ type: "reasoning", encrypted_content: "fresh-fixture" }),
    )
  })

  test("does not disable valid reasoning on a normal request", async () => {
    const local = fixture([accepted()])
    await local.run(history())
    expect(local.requests).toHaveLength(1)
    expect(local.recoveries).toHaveLength(0)
    expect(local.requests[0].body.input).toContainEqual(
      expect.objectContaining({ encrypted_content: "expired-fixture" }),
    )
  })

  test("does not loop when the recovery request also fails", async () => {
    const local = fixture([rejected(), rejected()])
    await expect(local.run(history())).rejects.toThrow("encrypted_content")
    expect(local.requests).toHaveLength(2)
  })

  test.each([
    ["invalid input", 400],
    ["reasoning `encrypted_content` has expired", 401],
    ["reasoning `encrypted_content` has expired", 429],
  ])("does not recover unrelated errors: %s (%s)", async (message, status) => {
    const local = fixture([rejected(message, status)])
    await expect(local.run(history())).rejects.toThrow(message)
    expect(local.requests).toHaveLength(1)
    expect(local.recoveries).toHaveLength(0)
  })

  test("does not retry an expiration error when there is no encrypted state to remove", async () => {
    const local = fixture([rejected()])
    await expect(local.run([{ role: "user", content: "Hello" }])).rejects.toThrow("encrypted_content")
    expect(local.requests).toHaveLength(1)
  })
})
