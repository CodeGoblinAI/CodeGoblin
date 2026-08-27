import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { npmWrapper } from "../../script/npm-wrapper"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

describe("npm launcher update", () => {
  test("keeps ordinary commands on the native binary path", () => {
    const source = npmWrapper({
      command: "cg",
      nativeCommand: "codegoblin",
      productName: "CodeGoblin",
      packageName: "@codegoblin-io/codegoblin",
    })
    expect(source).toContain("const target = updateRequest()")
    expect(source).toContain("else {\n  const child = childProcess.spawn(native, args")
  })

  test.skipIf(process.platform !== "win32")("waits for npm and restores the command before returning", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codegoblin-npm-wrapper-"))
    dirs.push(dir)
    const bin = path.join(dir, "package", "bin")
    await fs.promises.mkdir(bin, { recursive: true })
    await fs.promises.writeFile(path.join(dir, "package", "package.json"), JSON.stringify({ version: "1.2.3" }))
    await fs.promises.writeFile(path.join(bin, "codegoblin.exe"), "placeholder")
    await fs.promises.writeFile(
      path.join(bin, "cg.mjs"),
      npmWrapper({
        command: "cg",
        nativeCommand: "codegoblin",
        productName: "CodeGoblin",
        packageName: "@codegoblin-io/codegoblin",
      }),
    )
    await fs.promises.writeFile(
      path.join(dir, "npm.cmd"),
      `@echo off\r\necho %* > "${path.join(dir, "npm-args.txt")}"\r\ndel /q "${path.join(bin, "codegoblin.exe")}"\r\nping -n 2 127.0.0.1 > nul\r\necho placeholder> "${path.join(bin, "codegoblin.exe")}"\r\nexit /b 0\r\n`,
    )

    const started = Date.now()
    const result = Bun.spawnSync([process.execPath, path.join(bin, "cg.mjs"), "update", "9.9.9"], {
      env: { ...process.env, PATH: `${dir};${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("1.2.3")
    expect(result.stdout.toString()).toContain("9.9.9")
    expect(result.stdout.toString()).toContain("cg command is ready")
    expect(await fs.promises.readFile(path.join(dir, "npm-args.txt"), "utf8")).toContain(
      "install --global @codegoblin-io/codegoblin@9.9.9",
    )
    expect(Date.now() - started).toBeGreaterThanOrEqual(700)
    expect(fs.existsSync(path.join(bin, "codegoblin.exe"))).toBe(true)
  })
})
