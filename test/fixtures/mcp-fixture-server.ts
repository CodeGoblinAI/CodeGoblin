/**
 * A small MCP server over stdio, for the client tests.
 *
 * Behaviour switches come from the environment:
 *   FIXTURE_PROTOCOL       answer initialize with this version instead of the client's
 *   FIXTURE_EXIT_AT_START  exit straight away, after saying why on stderr
 *   FIXTURE_VALUE          what the env tool reports back
 */
type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: any }

const send = (message: Message) => process.stdout.write(JSON.stringify(message) + "\n")

process.stderr.write("fixture server starting\n")
if (process.env.FIXTURE_EXIT_AT_START) {
  process.stderr.write("fixture: told to fail at start\n")
  process.exit(3)
}

let initialized = false
let grown = false
const clientAnswers = new Map<number | string, (message: Message) => void>()

const TOOLS = () => [
  { name: "echo", description: "Say it back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "picture", description: "Returns an image.", inputSchema: { type: "object", properties: {} } },
  { name: "structured", description: "Structured content only." },
  { name: "slow", description: "Never answers." },
  { name: "grow", description: "Adds a tool." },
  { name: "ask_client", description: "Asks the client things." },
  { name: "env", description: "Reports FIXTURE_VALUE." },
  ...(grown ? [{ name: "grown", description: "Added later." }] : []),
]

function askClient(id: string, method: string): Promise<Message> {
  return new Promise((resolve) => {
    clientAnswers.set(id, resolve)
    send({ jsonrpc: "2.0", id, method })
  })
}

async function call(message: Message) {
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result })
  const text = (value: string) => reply({ content: [{ type: "text", text: value }] })
  if (!initialized) return text("called before notifications/initialized")

  switch (message.params?.name) {
    case "echo":
      return text("echo: " + message.params?.arguments?.text)
    case "fail":
      return reply({ content: [{ type: "text", text: "it broke" }], isError: true })
    case "picture":
      return reply({ content: [{ type: "text", text: "here" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] })
    case "structured":
      return reply({ content: [], structuredContent: { answer: 42 } })
    case "slow":
      return
    case "grow":
      grown = true
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      return text("grew")
    case "ask_client": {
      const roots = await askClient("srv-roots", "roots/list")
      const ping = await askClient("srv-ping", "ping")
      return text(`roots: ${roots.error?.code ?? "answered"}; ping: ${ping.result ? "ok" : "no"}`)
    }
    case "env":
      return text(String(process.env.FIXTURE_VALUE))
    default:
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "no such tool" } })
  }
}

function handle(message: Message) {
  if (message.id !== undefined && !message.method) {
    const waiting = clientAnswers.get(message.id)
    if (waiting) {
      clientAnswers.delete(message.id)
      waiting(message)
    }
    return
  }
  switch (message.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: process.env.FIXTURE_PROTOCOL ?? message.params?.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fixture", version: "1.0.0" },
          instructions: "fixture instructions",
        },
      })
    case "notifications/initialized":
      initialized = true
      return
    case "tools/list": {
      // Two pages, so the client has to follow the cursor.
      const all = TOOLS()
      const second = message.params?.cursor === "page2"
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: second ? all.slice(3) : all.slice(0, 3), ...(second ? {} : { nextCursor: "page2" }) },
      })
    }
    case "tools/call":
      void call(message)
      return
    case "ping":
      return send({ jsonrpc: "2.0", id: message.id, result: {} })
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method: " + message.method } })
      }
  }
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let at: number
  while ((at = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (line) handle(JSON.parse(line))
  }
})
process.stdin.on("end", () => process.exit(0))
