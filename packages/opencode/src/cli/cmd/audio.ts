import type { CommandModule } from "yargs"
import { CodeGoblinAudioCommand } from "@/codegoblin/audio-command"

type Args = {
  text?: string[]
  provider?: string
  output?: string
  model?: string
  voice?: string
  outputFormat?: string
  stability?: number
  similarityBoost?: number
  style?: number
  speed?: number
  speakerBoost?: boolean
  languageCode?: string
  seed?: number
  textNormalization?: "auto" | "on" | "off"
  languageTextNormalization?: boolean
  keyFile?: string
  listVoices?: boolean
  dryRun?: boolean
}

export const AudioCommand = {
  command: "audio [text..]",
  describe: "generate audio with ElevenLabs and save it locally",
  builder: (yargs) =>
    yargs
      .positional("text", {
        describe: "text to turn into audio",
        type: "string",
        array: true,
      })
      .option("provider", {
        describe: "audio provider to use: elevenlabs or google",
        type: "string",
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
      .option("output-format", {
        describe: "ElevenLabs output format, for example mp3_44100_128 or mp3_22050_32",
        type: "string",
      })
      .option("stability", {
        describe: "voice stability from 0 to 1",
        type: "number",
      })
      .option("similarity-boost", {
        describe: "voice similarity boost from 0 to 1",
        type: "number",
      })
      .option("style", {
        describe: "style exaggeration from 0 to 1 when supported by the model",
        type: "number",
      })
      .option("speed", {
        describe: "voice speed from 0.7 to 1.2",
        type: "number",
      })
      .option("speaker-boost", {
        describe: "enable ElevenLabs speaker boost for the request",
        type: "boolean",
      })
      .option("language-code", {
        describe: "optional ISO 639-1 language code, such as en or ja",
        type: "string",
      })
      .option("seed", {
        describe: "optional deterministic sampling seed",
        type: "number",
      })
      .option("text-normalization", {
        describe: "ElevenLabs text normalization mode",
        choices: ["auto", "on", "off"] as const,
      })
      .option("language-text-normalization", {
        describe: "enable language text normalization when supported",
        type: "boolean",
      })
      .option("key-file", {
        describe: "optional local env file containing ELEVENLABS_API_KEY or CODEGOBLIN_ELEVENLABS_API_KEY",
        type: "string",
      })
      .option("list-voices", {
        describe: "list ElevenLabs speakers/voice IDs available to this account",
        type: "boolean",
      })
      .option("dry-run", {
        describe: "validate path/model setup without calling ElevenLabs",
        type: "boolean",
      }),
  handler: async (args) => {
    const text = (args.text ?? []).join(" ").trim()
    if (args.listVoices) {
      const result = await CodeGoblinAudioCommand.voices({
        cwd: process.cwd(),
        keyFile: args.keyFile,
        provider: args.provider,
      })
      if (!result.ok) {
        console.error(result.message)
        process.exitCode = 1
        return
      }
      for (const voice of result.voices) {
        console.log(
          [
            voice.id,
            voice.name,
            voice.category,
            voice.labels?.accent,
            voice.labels?.gender,
            voice.description,
          ]
            .filter(Boolean)
            .join("\t"),
        )
      }
      return
    }
    if (!text) {
      console.error('Usage: codegoblin audio "text to speak" --output codegoblin-output/audio/demo.mp3')
      process.exitCode = 1
      return
    }
    const plan = CodeGoblinAudioCommand.describe({
      text,
      provider: args.provider,
      output: args.output,
      model: args.model,
      voice: args.voice,
      outputFormat: args.outputFormat,
      keyFile: args.keyFile,
      cwd: process.cwd(),
      dryRun: args.dryRun,
    })
    console.log(`${args.dryRun ? "Checking" : "Generating"} CodeGoblin audio with ${plan.provider}/${plan.model}; output: ${plan.output}`)
    const result = await CodeGoblinAudioCommand.generate({
      text,
      provider: args.provider,
      output: args.output,
      model: args.model,
      voice: args.voice,
      outputFormat: args.outputFormat,
      voiceSettings: {
        stability: args.stability,
        similarityBoost: args.similarityBoost,
        style: args.style,
        speed: args.speed,
        useSpeakerBoost: args.speakerBoost,
      },
      languageCode: args.languageCode,
      seed: args.seed,
      applyTextNormalization: args.textNormalization,
      applyLanguageTextNormalization: args.languageTextNormalization,
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