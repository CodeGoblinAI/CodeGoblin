const port = Number(process.env.CODEGOBLIN_MOCK_GATEWAY_PORT || 8787)

const models = [
  {
    id: "deepseek-chat",
    object: "model",
    owned_by: "codegoblin-mock",
  },
  {
    id: "goblin-mock",
    object: "model",
    owned_by: "codegoblin-mock",
  },
]

const transparentPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    ...init,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      ...(init?.headers ?? {}),
    },
  })
}

function streamChat() {
  const encoder = new TextEncoder()
  const chunks = [
    {
      id: "chatcmpl-codegoblin-mock",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "CodeGoblin mock gateway response." }, finish_reason: null }],
    },
    {
      id: "chatcmpl-codegoblin-mock",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
  )
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "OPTIONS") return json({})

    if (url.pathname === "/v1/models" && request.method === "GET") {
      return json({ object: "list", data: models })
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      const body = await request.json().catch(() => ({} as any))
      if (body.stream) return streamChat()
      return json({
        id: "chatcmpl-codegoblin-mock",
        object: "chat.completion",
        model: body.model || "goblin-mock",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "CodeGoblin mock gateway response. Replace this with the private hosted DeepSeek route later.",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 12,
          total_tokens: 20,
        },
      })
    }

    if (url.pathname === "/v1/messages" && request.method === "POST") {
      return json({
        id: "msg_codegoblin_mock",
        type: "message",
        role: "assistant",
        model: "goblin-mock",
        content: [{ type: "text", text: "CodeGoblin mock Anthropic-compatible response." }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 8,
          output_tokens: 8,
        },
      })
    }

    if (url.pathname === "/v1/images/generations" && request.method === "POST") {
      return json({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: transparentPng }],
      })
    }

    if (url.pathname === "/v1/me/balance" && request.method === "GET") {
      return json({
        mode: "mock",
        currency: "USD",
        credits: 0,
        message: "Hosted wallet balance is scaffolded only.",
      })
    }

    if (url.pathname === "/v1/me/usage" && request.method === "GET") {
      return json({
        mode: "mock",
        text_requests: 0,
        image_requests: 0,
        estimated_cost: 0,
      })
    }

    return json({ error: { message: `Not found: ${url.pathname}` } }, { status: 404 })
  },
})

console.log(`CodeGoblin mock gateway listening on http://127.0.0.1:${port}/v1`)
