/**
 * Stands in for llama-server: the flags CG-Next passes, the key it sets in
 * LLAMA_API_KEY, /health while "loading", and a streamed chat reply.
 *
 *   FAKE_LLAMA_LOAD_MS  how long /health answers 503 first (default 150)
 *   FAKE_LLAMA_EXIT     exit with this code during load instead of serving
 */
const args = process.argv.slice(2)
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const port = Number(flag("--port"))
const alias = flag("--alias") ?? "unknown"
const key = process.env.LLAMA_API_KEY
const loadMs = Number(process.env.FAKE_LLAMA_LOAD_MS ?? 150)
const started = Date.now()

console.log("fake llama-server " + JSON.stringify(args))
if (process.env.FAKE_LLAMA_EXIT) setTimeout(() => { console.error("error: failed to load model"); process.exit(Number(process.env.FAKE_LLAMA_EXIT)) }, 50)

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Date.now() - started < loadMs ? new Response("loading", { status: 503 }) : Response.json({ status: "ok" })
    if (key && request.headers.get("authorization") !== "Bearer " + key) return new Response("unauthorized", { status: 401 })
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: alias }] })
    if (url.pathname === "/v1/chat/completions") {
      const body = await request.json() as { messages: unknown[]; tools?: unknown[] }
      const reply = `hello from ${alias} (${body.tools ? "tools" : "chat"})`
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return new Response("not found", { status: 404 })
  },
})
