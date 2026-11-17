import fs from "node:fs"
import fsp from "node:fs/promises"

/**
 * Puts a finished file in place of another: the last step of every save that must never leave half a file.
 *
 * On Windows a rename onto a file fails (EPERM, EACCES or EBUSY) for as long as any other program has that
 * file open - a second CG-Next window listing conversations, a virus scanner looking at what was just
 * written, a backup tool. With another process reading a conversation in a loop, 2,204 of 2,326 saves
 * failed, and every caller dropped the failure: the conversation was simply not saved, and the temporary
 * file was left behind. Such a hold lasts milliseconds, so the rename is tried again for up to a few seconds.
 * If it still fails the temporary file is removed and the error is thrown - unless `keep` says the source is
 * worth more than that (a finished download is not thrown away because it could not be moved).
 */
const HELD = new Set(["EPERM", "EACCES", "EBUSY"])
const TRIES = 14
const pause = (attempt: number) => Math.min(10 * 2 ** attempt, 400)

const held = (error: unknown) => process.platform === "win32" && HELD.has((error as NodeJS.ErrnoException).code ?? "")

export async function replaceFile(from: string, to: string, { keep = false } = {}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(from, to)
    } catch (error) {
      if (!held(error) || attempt >= TRIES) {
        if (!keep) await fsp.rm(from, { force: true }).catch(() => {})
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, pause(attempt)))
    }
  }
}

/**
 * Writes a whole file or leaves the old one as it was. Written in place, a file that a crash, a power cut or
 * a full disk interrupted was left cut short - a conversation that then would not open, settings that would
 * not load. The text goes to a file beside it first, and only a finished file takes its place.
 */
export async function writeFileWhole(file: string, text: string, mode?: number): Promise<void> {
  const temporary = file + "." + process.pid + "-" + Math.random().toString(36).slice(2) + ".tmp"
  await fsp.writeFile(temporary, text, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) })
  await replaceFile(temporary, file)
}

export function writeFileWholeSync(file: string, text: string, mode?: number): void {
  const temporary = file + "." + process.pid + "-" + Math.random().toString(36).slice(2) + ".tmp"
  fs.writeFileSync(temporary, text, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) })
  replaceFileSync(temporary, file)
}

/** The same, for the few saves that cannot wait for a promise. */
export function replaceFileSync(from: string, to: string, { keep = false } = {}): void {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to)
    } catch (error) {
      if (!held(error) || attempt >= TRIES) {
        if (!keep) try { fs.rmSync(from, { force: true }) } catch {}
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause(attempt))
    }
  }
}
