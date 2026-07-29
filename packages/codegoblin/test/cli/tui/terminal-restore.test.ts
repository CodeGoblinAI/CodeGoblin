import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import {
  installTerminalRestore,
  resetTerminalRestoreForTests,
  restoreTerminal,
  TERMINAL_RESTORE_SEQUENCES,
} from "@/cli/cmd/tui/terminal-restore"

/**
 * herdr #1332: a session that dies without unwinding leaves the terminal in
 * mouse-tracking + kitty-keyboard mode. These assert the escape sequences are
 * actually emitted, and emitted only once.
 */
describe("terminal restore", () => {
  let writes: string[]
  let originalWriteSync: typeof fs.writeSync
  let originalIsTTY: boolean | undefined

  beforeEach(() => {
    resetTerminalRestoreForTests()
    writes = []
    originalWriteSync = fs.writeSync
    originalIsTTY = process.stdout.isTTY
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    // @ts-expect-error narrow test double
    fs.writeSync = (fd: number, data: string) => {
      if (fd === 1) writes.push(String(data))
      return 0
    }
  })

  afterEach(() => {
    fs.writeSync = originalWriteSync
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true })
    resetTerminalRestoreForTests()
    process.removeAllListeners("SIGTERM")
  })

  test("emits every mode reset", () => {
    restoreTerminal()
    const out = writes.join("")

    expect(out).toContain("\x1b[<u") // kitty keyboard popped
    expect(out).toContain("\x1b[?1003l") // any-event mouse off
    expect(out).toContain("\x1b[?1002l")
    expect(out).toContain("\x1b[?1000l")
    expect(out).toContain("\x1b[?1006l") // SGR coordinates off
    expect(out).toContain("\x1b[?1015l")
    expect(out).toContain("\x1b[?2004l") // bracketed paste off
    expect(out).toContain("\x1b[?25h") // cursor visible
    expect(out).toContain("\x1b[?1049l") // primary screen
  })

  test("leaves the alternate screen last so the cursor lands on the primary buffer", () => {
    restoreTerminal()
    const out = writes.join("")
    expect(out.indexOf("\x1b[?25h")).toBeLessThan(out.indexOf("\x1b[?1049l"))
  })

  test("is idempotent across racing handlers", () => {
    restoreTerminal()
    restoreTerminal()
    restoreTerminal()
    expect(writes.length).toBe(1)
    expect(writes[0]).toBe(TERMINAL_RESTORE_SEQUENCES)
  })

  test("does nothing when stdout is not a tty", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    restoreTerminal()
    expect(writes).toEqual([])
  })

  test("survives a failing write on the way out", () => {
    fs.writeSync = () => {
      throw new Error("EBADF")
    }
    expect(() => restoreTerminal()).not.toThrow()
  })

  test("installs an exit hook and a SIGTERM hook, once", () => {
    const before = process.listenerCount("exit")
    installTerminalRestore()
    installTerminalRestore()

    expect(process.listenerCount("exit")).toBe(before + 1)
    expect(process.listenerCount("SIGTERM")).toBe(1)

    process.removeListener("exit", restoreTerminal)
  })

  test("does not hijack SIGINT or SIGHUP, which the TUI already owns", () => {
    installTerminalRestore()
    expect(process.listenerCount("SIGINT")).toBe(0)
    expect(process.listenerCount("SIGHUP")).toBe(0)

    process.removeListener("exit", restoreTerminal)
  })
})
