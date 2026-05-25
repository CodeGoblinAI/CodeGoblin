import type { CommandModule } from "yargs"
import { CodeGoblinImageCommand } from "@/codegoblin/image-command"

type Args = {
  prompt?: string[]
  output?: string
  model?: string
  provider?: string
  keyFile?: string
  input?: string[]
  dryRun?: boolean
}

export const ImageCommand = {
  command: "image <prompt..>",
  describe: "generate an image with a selected image model and save it locally",
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
        describe: "image-capable model",
        type: "string",
      })
      .option("provider", {
        describe: "image provider: google, xai, openai, or qwen",
        type: "string",
      })
      .option("input", {
        alias: "i",
        describe: "optional input image path for image editing/reference",
        type: "string",
        array: true,
      })
      .option("key-file", {
        describe: "optional local env file containing image provider keys",
        type: "string",
      })
      .option("dry-run", {
        describe: "validate path/model setup without calling Gemini",
        type: "boolean",
      }),
  handler: async (args) => {
    const prompt = (args.prompt ?? []).join(" ").trim()
    const inputImages = (args.input ?? []).map((item) => ({ path: item }))
    const plan = CodeGoblinImageCommand.describe({
      prompt,
      output: args.output,
      model: args.model,
      provider: args.provider,
      keyFile: args.keyFile,
      cwd: process.cwd(),
      dryRun: args.dryRun,
      inputImages,
    })
    const provider = plan.provider ?? "google"
    const model = plan.model ?? "gemini-2.5-flash-image"
    const output = plan.output ?? args.output ?? "codegoblin-output/images"
    console.log(
      `${args.dryRun ? "Checking" : "Generating"} CodeGoblin image with ${provider}/${model}; output: ${output}`,
    )
    if (inputImages.length > 0) {
      console.log(`Using ${inputImages.length} input image${inputImages.length === 1 ? "" : "s"} for edit/reference.`)
    }
    const result = await CodeGoblinImageCommand.generate({
      prompt,
      output: args.output,
      model: args.model,
      provider: args.provider,
      keyFile: args.keyFile,
      cwd: process.cwd(),
      dryRun: args.dryRun,
      inputImages,
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
