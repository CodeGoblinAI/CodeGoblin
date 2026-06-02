import { Flag } from "@codegoblin/core/flag/flag"
import { Effect } from "effect"
import os from "os"
import path from "path"

const tmpRoot = process.env.TMPDIR ?? os.tmpdir()
const preserveExerciseGlobalRoot = !!process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.OPENCODE_HTTPAPI_EXERCISE_GLOBAL ?? path.join(tmpRoot, `opencode-httpapi-global-${process.pid}`)
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "opencode")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "opencode")

const preserveExerciseDatabase = !!process.env.OPENCODE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath = process.env.OPENCODE_HTTPAPI_EXERCISE_DB ?? process.env.OPENCODE_DB!
process.env.OPENCODE_DB = exerciseDatabasePath
Flag.OPENCODE_DB = exerciseDatabasePath

export const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
