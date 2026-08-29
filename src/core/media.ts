import path from "node:path"

/**
 * Images, audio and 3D models.
 *
 * The generators themselves came over from the original whole and already
 * work; what was missing was any way to reach them. This is that way, and
 * nothing more - one shape of result for all three, so a surface renders a
 * finished picture the same way it renders a finished sound.
 *
 * Each generator is imported at the point of use. Together they are close to
 * two thousand lines, and a conversation that never asks for an image should
 * not pay to load the code that would have made one.
 */

/**
 * Where the generators write.
 *
 * Named here because the web server serves files from it and needs to serve
 * from nowhere else.
 */
export const MEDIA_OUTPUT_DIR = "codegoblin-output"

/**
 * The model a generator should use.
 *
 * There is one list of models, and whichever is selected decides what a
 * prompt becomes - the same way the original works. Passing the selection
 * through is the whole point: without it /image quietly fell back to a
 * default provider and picking Tripo changed nothing.
 */
export type Chosen = { provider?: string; model?: string }
export type MediaKind = "image" | "audio" | "model3d"

export type MediaResult = {
  ok: boolean
  message: string
  /** Path of the file that was written, relative to the working directory. */
  output?: string
  model?: string
  provider?: string
  /** What it cost, when the provider says. */
  cost?: number
  /** Nothing was generated and nothing was spent - so say so, rather than
   * naming a file that is not there. */
  dryRun?: boolean
}

export const MEDIA_KINDS: { kind: MediaKind; command: string; description: string }[] = [
  { kind: "image", command: "/image", description: "generate an image: /image a goblin reading code" },
  { kind: "audio", command: "/audio", description: "speak some text: /audio hello there" },
  { kind: "model3d", command: "/model3d", description: "generate a 3D model: /model3d a small stone bridge" },
]

/** The prompt, with the command word taken off the front. */
export function promptFrom(line: string, command: string): string {
  const trimmed = line.trim()
  return trimmed.toLowerCase().startsWith(command) ? trimmed.slice(command.length).trim() : trimmed
}

async function runImage(line: string, cwd: string, chosen: Chosen): Promise<MediaResult> {
  const { CodeGoblinImageCommand } = await import("../domain/image-command")
  // requireImageModel makes it say so rather than guess when the selected
  // model is not one that draws. Flags on the line still win over it.
  const result = await CodeGoblinImageCommand.runSlash({
    input: line,
    cwd,
    provider: chosen.provider,
    model: chosen.model,
    requireImageModel: true,
  })
  return {
    ok: result.ok,
    message: result.message,
    output: result.output,
    model: result.model,
    provider: result.provider,
    cost: result.cost,
  }
}

async function runAudio(line: string, cwd: string, chosen: Chosen): Promise<MediaResult> {
  const { CodeGoblinAudioCommand } = await import("../domain/audio-command")
  const text = promptFrom(line, "/audio")
  if (!text) return { ok: false, message: "say what to speak: /audio hello there" }

  // Audio has no slash entry point of its own - it takes the text directly.
  const result = await CodeGoblinAudioCommand.generate({
    text,
    cwd,
    provider: chosen.provider,
    model: chosen.model,
  })
  return {
    ok: result.ok,
    message: result.message,
    output: result.output,
    model: result.model,
    provider: result.provider,
  }
}

async function runModel3d(line: string, cwd: string, chosen: Chosen): Promise<MediaResult> {
  const { CodeGoblin3DCommand } = await import("../domain/model3d-command")
  const result = await CodeGoblin3DCommand.runSlash({
    input: line,
    cwd,
    provider: chosen.provider,
    model: chosen.model,
    require3DModel: true,
  })
  return {
    ok: result.ok,
    message: result.message,
    output: result.output,
    model: result.model,
    provider: result.provider,
  }
}

/**
 * Run one of them.
 *
 * A generator that throws is reported, not rethrown: a failed image is a
 * disappointing answer, not a reason for the conversation to end.
 */
export async function runMedia(
  kind: MediaKind,
  line: string,
  cwd: string,
  chosen: Chosen = {},
): Promise<MediaResult> {
  const dryRun = / --dry-run\b/.test(" " + line)
  try {
    const result =
      kind === "image"
        ? await runImage(line, cwd, chosen)
        : kind === "audio"
          ? await runAudio(line, cwd, chosen)
          : await runModel3d(line, cwd, chosen)
    return { ...result, output: relativise(result.output, cwd), dryRun }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "generation failed", dryRun }
  }
}

/**
 * Paths as they would be typed.
 *
 * The generators return absolute paths, which are mostly the same forty
 * characters of home directory repeated back at someone who knows where they
 * are. Anything outside the working directory keeps its full path, since
 * that is the part worth noticing.
 */
function relativise(target: string | undefined, cwd: string): string | undefined {
  if (!target) return target
  const relative = path.relative(cwd, target)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : target
}

/**
 * Whether a file is one of ours to hand back.
 *
 * The web server serves generated media to the page. The first version served
 * anything inside the working directory, which included .git/config - a file
 * that quite often carries a token in a remote URL. The rule lives here so it
 * can be tested rather than trusted.
 */
export function withinMediaOutput(root: string, target: string): boolean {
  const outputRoot = path.resolve(root, MEDIA_OUTPUT_DIR)
  const absolute = path.resolve(root, target)
  const within = path.relative(outputRoot, absolute)
  if (within === "") return false
  return !within.startsWith("..") && !path.isAbsolute(within)
}

/** One line describing what came back, for a status bar or a transcript. */
export function describeMedia(result: MediaResult): string {
  // A dry run wrote nothing, so naming a file would be describing something
  // that is not there.
  if (!result.ok || result.dryRun) return result.message
  const parts = [result.output ?? "done"]
  if (result.model) parts.push("via " + result.model)
  if (typeof result.cost === "number" && result.cost > 0) parts.push("$" + result.cost.toFixed(4))
  return parts.join("  ")
}
