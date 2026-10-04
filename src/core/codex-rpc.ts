/** Owned, bounded stdio client. Authentication remains entirely in the official CLI. */
export class CodexRpc {
  private process: Bun.Subprocess<"pipe", "pipe", "pipe">
  private next = 0
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private listeners = new Set<(method: string, params: unknown) => void>()
  private closedListeners = new Set<() => void>()
  private failure?: Error
  private lifetime: ReturnType<typeof setTimeout>
  userAgent = ""

  private constructor(command: string[], timeout: number) {
    this.process = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true })
    this.lifetime = setTimeout(() => this.close(), timeout)
    // Drain diagnostics without retaining credential-bearing errors or account identifiers.
    const diagnostics = this.process.stderr
    void (async () => { for await (const _ of diagnostics) {} })().catch(() => {})
    void this.read().catch(() => this.fail(new Error("Codex protocol failed; update or check the official CLI")))
    void this.process.exited.then(() => this.fail(new Error("Codex app-server stopped")))
  }

  static async start(command?: string[], timeout = 30_000, experimental = false) {
    const executable = Bun.which(process.platform === "win32" ? "codex.exe" : "codex")
    if (!command && !executable) throw new Error("Install the official Codex CLI and run codex login")
    const rpc = new CodexRpc(command ?? [executable!, "app-server", "--stdio"], timeout)
    try {
      const initialized = object(await rpc.call("initialize", { clientInfo: { name: "cg_next", title: "CodeGoblin", version: "0.0.0" }, ...(experimental ? { capabilities: { experimentalApi: true } } : {}) }))
      rpc.userAgent = typeof initialized.userAgent === "string" ? initialized.userAgent : ""
      rpc.write({ method: "initialized", params: {} })
      return rpc
    } catch (error) { await rpc.close(); throw error }
  }

  call(method: string, params: unknown = {}, timeout = 15_000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("Codex request timed out: " + method))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) }
      catch { this.fail(new Error("Could not send Codex request")) }
    })
  }

  onNotification(listener: (method: string, params: unknown) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get closed() { return Boolean(this.failure) }

  onClosed(listener: () => void) {
    this.closedListeners.add(listener)
    if (this.closed) listener()
    return () => this.closedListeners.delete(listener)
  }

  private write(value: unknown) {
    this.process.stdin.write(JSON.stringify(value) + "\n")
    this.process.stdin.flush()
  }

  private async read() {
    const decoder = new TextDecoder()
    let buffer = ""
    let bytes = 0
    for await (const chunk of this.process.stdout) {
      bytes += chunk.byteLength
      if (bytes > 32 * 1024 * 1024) throw new Error("Codex output limit")
      buffer += decoder.decode(chunk, { stream: true })
      if (buffer.length > 16 * 1024 * 1024) throw new Error("Codex frame limit")
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const packet = object(JSON.parse(line))
        if (typeof packet.method === "string") {
          if (packet.id !== undefined) {
            // Account/import clients never own inference. Reject all server-side tool/approval requests.
            this.write({ id: packet.id, error: { code: -32601, message: "CG-Next account client does not execute tools" } })
            continue
          }
          for (const listener of this.listeners) listener(packet.method, packet.params)
          continue
        }
        if (typeof packet.id !== "number") continue
        const pending = this.pending.get(packet.id)
        if (!pending) continue
        clearTimeout(pending.timer)
        this.pending.delete(packet.id)
        if (packet.error) pending.reject(new Error("Codex rejected " + "request " + packet.id + "; check CLI compatibility/sign-in"))
        else pending.resolve(packet.result)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) throw new Error("Incomplete Codex frame")
  }

  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    clearTimeout(this.lifetime)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const listener of this.closedListeners) listener()
    if (this.process.exitCode === null) this.process.kill()
  }

  async close() {
    this.fail(new Error("Codex client closed"))
    await this.process.exited
  }
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
