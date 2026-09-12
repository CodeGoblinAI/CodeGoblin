/**
 * What the terminal was started with.
 *
 * Pure, so the rules can be tested without starting a terminal - which is how
 * this broke without anyone noticing. The directory argument was added as "the
 * first argument that is not a flag", and the value after --model is not a
 * flag, so `--model zai/glm-5.3` asked to open a directory called zai/glm-5.3
 * and exited. That is the usage app.ts advertises in its own header.
 */
export type Launch = {
  /** Where to work, when one was named. */
  directory?: string
  /** The model to start on, as "provider/model" or a bare provider id. */
  model?: string
}

/** Flags that take the next argument as their value. */
const TAKES_VALUE = new Set(["--model", "--provider"])

export function parseLaunch(argv: string[]): Launch {
  let directory: string | undefined
  let model: string | undefined
  let provider: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const entry = argv[index]!
    if (TAKES_VALUE.has(entry)) {
      const value = argv[index + 1]
      // A flag at the very end, or followed straight by another flag, has no
      // value. Ignoring it beats swallowing the next flag as a model name.
      if (value !== undefined && !value.startsWith("--")) {
        if (entry === "--model") model = value
        else provider = value
        index++
      }
      continue
    }
    if (entry.startsWith("--")) continue
    directory ??= entry
  }
  // --model wins over --provider, as it always did.
  return { directory, model: model ?? provider }
}
