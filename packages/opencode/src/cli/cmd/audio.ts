import type { CommandModule } from "yargs"
import { CodeGoblinAudioCommand } from "@/codegoblin/audio-command"

type Args = {
  text?: string[]
  output?: string
  model?: string
  voice?: string
  keyFile?: string
  dryRun?: boolean
}

export const AudioCommand = {
  command: "audio <text..>",
  describe: "generate audio with ElevenLabs and save it locally",
  builder: (yargs) =>
    yargs
      .positional("text", {
        describe: "text to turn into audio",
        type: "string",
        array: true,
      })
      .option("output", {
        alias: "o",
        describe: "project-relative output path",
        type: "string",
      })
      .option("model", {
        describe: "ElevenLabs model ID or CodeGoblin audio alias",
        type: "string",
      })
      .option("voice", {
        describe: "ElevenLabs voice ID",
        type: "string",
      })
      .option("key-file", {
        describe: "optional local env file containing ELEVENLABS_API_KEY",
        type: "string",
      })
      .option("dry-run", {
        describe: "validate path/model setup without calling ElevenLabs",
        type: "boolean",
      }),
  handler: async (args) => {
    const text = (args.text ?? []).join(" ").trim()
    if (!text) {
      console.error('Usage: codegoblin audio "text to speak" --output codegoblin-output/audio/demo.mp3')
      process.exitCode = 1
      return
    }
    const plan = CodeGoblinAudioCommand.describe({
      text,
      output: args.output,
      model: args.model,
      voice: args.voice,
      keyFile: args.keyFile,
      cwd: process.cwd(),
      dryRun: args.dryRun,
    })
    console.log(`${args.dryRun ? "Checking" : "Generating"} CodeGoblin audio with elevenlabs/${plan.model}; output: ${plan.output}`)
    const result = await CodeGoblinAudioCommand.generate({
      text,
      output: args.output,
      model: args.model,
      voice: args.voice,
      keyFile: args.keyFile,
      cwd: process.cwd(),
      dryRun: args.dryRun,
    }).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : "CodeGoblin audio command failed.",
    }))
    if (!result.ok) {
      console.error(result.message)
      process.exitCode = 1
      return
    }
    console.log(result.message)
  },
} satisfies CommandModule<object, Args>