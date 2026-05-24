import type { CommandModule } from "yargs"
import { CodeGoblinImageCommand } from "@/codegoblin/image-command"

type Args = {
  prompt?: string[]
  output?: string
  model?: string
  dryRun?: boolean
}

export const ImageCommand = {
  command: "image <prompt..>",
  describe: "generate an image with Gemini and save it locally",
  builder: (yargs) =>
    yargs
      .positional("prompt", {
        describe: "image prompt",
        type: "string",
        array: true,
      })
      .option("output", {
        alias: "o",
        describe: "project-relative output path",
        type: "string",
      })
      .option("model", {
        describe: "Gemini image-capable model",
        type: "string",
      })
      .option("dry-run", {
        describe: "validate path/model setup without calling Gemini",
        type: "boolean",
      }),
  handler: async (args) => {
    const prompt = (args.prompt ?? []).join(" ").trim()
    const result = await CodeGoblinImageCommand.generate({
      prompt,
      output: args.output,
      model: args.model,
      cwd: process.cwd(),
      dryRun: args.dryRun,
    }).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : "CodeGoblin image command failed.",
    }))
    if (!result.ok) {
      console.error(result.message)
      process.exitCode = 1
      return
    }
    console.log(result.message)
  },
} satisfies CommandModule<object, Args>
