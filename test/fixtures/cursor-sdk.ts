const mode = process.argv[2] || "normal"
const emit = (packet: unknown) => process.stdout.write(JSON.stringify(packet) + "\n")
let buffer = ""
let started = false
for await (const part of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(part)
  const lines = buffer.split("\n")
  buffer = lines.pop() || ""
  for (const line of lines) {
    if (!line) continue
    if (started) { if (line === '{"cancel":true}') process.exit(0); continue }
    started = true
    const input = JSON.parse(line)
    process.stderr.write("secret-token-fixture diagnostics\n")
    if (input.op === "login") {
      emit({ type: "url", url: mode === "bad-url" ? "https://evil.example/loginDeepControl?redirectTarget=sdk" : "https://cursor.com/loginDeepControl?uuid=fixture&challenge=fixture&redirectTarget=sdk" })
      if (mode === "login-complete") { emit({ type: "done" }); process.exit(0) }
      continue
    }
    if (input.op === "status") { emit({ type: "status", ready: mode !== "signed-out" }); emit({ type: "done" }); process.exit(0) }
    if (input.op === "models") {
      if (mode === "model-error") { emit({ type: "error" }); process.exit(1) }
      emit({ type: "models", models: [{ id: "fixture", label: "Fixture model" }, { id: "../bad", label: "Invalid" }] })
      emit({ type: "done" }); process.exit(0)
    }
    if (mode === "hang") { emit({ type: "thinking", delta: "Fixture" }); continue }
    if (mode === "native") { emit({ type: "tool_call", name: "shell" }); continue }
    if (mode === "error") { emit({ type: "error", message: "secret-token-fixture" }); process.exit(1) }
    if (mode === "credential") {
      if (input.mode === "cursor" && input.apiKey !== undefined) { emit({ type: "error" }); process.exit(1) }
      if (input.mode === "cursor-api" && input.apiKey !== "explicit-key-fixture") { emit({ type: "error" }); process.exit(1) }
      if (process.env.CURSOR_API_KEY || process.env.CURSOR_BACKEND_URL || process.env.DEEPSEEK_API_KEY) { emit({ type: "error" }); process.exit(1) }
    }
    const wire = JSON.parse(input.prompt)
    const result = wire.conversation.some((entry: { role: string }) => entry.role === "tool")
    const calls = result ? [] : [{ name: "write_file", arguments: JSON.stringify({ path: "cursor-fixture.txt", content: "CURSOR_FIXTURE" }) }]
    emit({ type: "text", delta: JSON.stringify({ text: result ? "Fixture finished" : "Done", calls }) })
    emit({ type: "spend", input: 14, output: 5 })
    if (mode === "truncated") process.exit(0)
    emit({ type: "done" }); process.exit(0)
  }
}
