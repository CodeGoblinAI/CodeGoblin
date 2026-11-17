import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { replaceFile } from "../src/platform/replace-file"

/**
 * A save while another program has the file open. On Windows the final rename fails for as long as the
 * other program holds the file; with another process reading in a loop, 2,204 of 2,326 saves failed, every
 * caller dropped the failure, and the temporary files were left behind.
 */
test("saves land while another process keeps reading the file, and leave nothing behind", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-replace-"))
  const target = path.join(dir, "session.json")
  fs.writeFileSync(target, JSON.stringify({ n: -1 }))
  const reader = Bun.spawn([process.execPath, "-e", `const fs=require("fs");const end=Date.now()+6000;while(Date.now()<end){try{fs.readFileSync(${JSON.stringify(target)})}catch{}}`], { stdout: "ignore", stderr: "ignore" })
  try {
    await Bun.sleep(300)
    for (let n = 0; n < 40; n++) {
      const temporary = target + "." + n + ".tmp"
      fs.writeFileSync(temporary, JSON.stringify({ n, pad: "x".repeat(20000) }))
      await replaceFile(temporary, target)
    }
    expect(JSON.parse(fs.readFileSync(target, "utf8")).n).toBe(39)
    expect(fs.readdirSync(dir)).toEqual(["session.json"])
  } finally {
    reader.kill()
  }
}, 60_000)

test("a rename that cannot happen for another reason fails at once, and its temporary file goes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-replace-"))
  const temporary = path.join(dir, "x.tmp")
  fs.writeFileSync(temporary, "x")
  const started = Date.now()
  await expect(replaceFile(temporary, path.join(dir, "no-such-folder", "x.json"))).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(1000)
  expect(fs.existsSync(temporary)).toBe(false)
})
