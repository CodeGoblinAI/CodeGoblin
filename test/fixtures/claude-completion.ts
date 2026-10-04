// A real stdio peer; no provider, auth files or native tools are involved.
let prompt = ""
for await (const chunk of process.stdin) prompt += chunk.toString()
const mode = process.argv[2]
const input = JSON.parse(prompt)
const messages = input.conversation as { role: string; content: string }[]
const tools = input.cg_tools as { function: { name: string } }[]
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
send({ type: "system", subtype: "init", tools: mode === "native" ? ["Bash"] : [], mcp_servers: [] })
if (mode === "hang") await new Promise(() => {})
const hasResults = messages.some((message) => message.role === "tool")
const summary = messages.at(-1)?.content.includes("Summarise the conversation")
const calls = hasResults || summary ? [] : [{ name: mode === "shell" ? "shell" : mode === "mcp" ? "mcp__fixture__echo" : "write_file", arguments: JSON.stringify(mode === "shell" ? { command: "echo CLI_FIXTURE > cli-fixture.txt" } : { path: "cli-fixture.txt", content: "CLI_FIXTURE" }) }]
const response = mode === "invalid" ? "not JSON" : JSON.stringify({ text: summary ? "Fixture summary preserves decisions" : hasResults ? "Received the CG tool result" : "Requested the CG tool", calls })
if (mode === "wire") {
  if (!messages[0]?.content.includes("MEMORY_SENTINEL") || !messages[0]?.content.includes("INSTRUCTIONS_SENTINEL") || !tools.length) throw new Error("Missing shared context")
}
send({ type: "stream_event", event: { delta: { type: "text_delta", text: response.slice(0, 8) } } })
send({ type: "stream_event", event: { delta: { type: "text_delta", text: response.slice(8) } } })
send({ type: "result", subtype: "success", result: response, ...(mode !== "invalid" ? { structured_output: JSON.parse(response) } : {}), usage: { input_tokens: 10, output_tokens: 20 }, ...(mode === "limited" ? { stop_reason: "max_tokens" } : {}) })
