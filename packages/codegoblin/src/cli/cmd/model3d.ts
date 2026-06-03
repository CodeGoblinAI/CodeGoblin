import type { CommandModule } from "yargs"
import { CodeGoblin3DCommand } from "@/codegoblin/model3d-command"

type Args = {
  prompt?: string[]
  output?: string
  model?: string
  provider?: string
  modelVersion?: string
  input?: string[]
  outputFormat?: string
  keyFile?: string
  dryRun?: boolean
}

export const Model3DCommand = {
  command: "model3d <prompt..>",
  describe: "generate a 3D model with Tripo and save it locally",
  builder: (yargs) =>
    yargs
      .positional("prompt", {
        describe: "text prompt for text-to-3D (optional when --input is provided)",
        type: "string",
        array: true,
      })
      .option("output", {
        alias: "o",
        describe: "project-relative output path",
        type: "string",
      })
      .option("model", {
        describe: "Tripo model id: text-to-model or image-to-model",
        type: "string",
      })
      .option("provider", {
        describe: "3D provider (tripo)",
        type: "string",
        default: "tripo",
      })
      .option("model-version", {
        describe: "Tripo model version variant",
        type: "string",
      })
      .option("input", {
        alias: "i",
        describe: "input image path for image-to-3D",
        type: "string",
        array: true,
      })
      .option("output-format", {
        describe: "output format (glb or obj)",
        type: "string",
        default: "glb",
      })
      .option("key-file", {
        describe: "optional local env file containing TRIPO_API_KEY",
        type: "string",
      })
      .option("dry-run", {
        describe: "validate path/model setup without calling Tripo",
        type: "boolean",
      }),
  handler: async (args) => {
    const prompt = (args.prompt ?? []).join(" ").trim()
    const inputImages = (args.input ?? []).map((item) => ({ path: item }))
    const plan = CodeGoblin3DCommand.describe({
      prompt,
      output: args.output,
      model: args.model,
      provider: args.provider,
      modelVersion: args.modelVersion,
      inputImages,
      outputFormat: args.outputFormat,
      keyFile: args.keyFile,
      cwd: process.cwd(),
      dryRun: args.dryRun,
      require3DModel: true,
    })
    if (!plan.supported) {
      console.error("Select a 3D-capable model with --provider tripo and --model text-to-model or image-to-model.")
      process.exitCode = 1
      return
    }
    console.log(
      `${args.dryRun ? "Checking" : "Generating"} CodeGoblin 3D with ${plan.provider}/${plan.model} (${plan.inputMode}, ${plan.modelVersion}); output: ${plan.output}`,
    )
    const result = await CodeGoblin3DCommand.generate({
      prompt,
      output: plan.output,
      model: args.model,
      provider: args.provider,
      modelVersion: args.modelVersion,
      inputImages,
      outputFormat: args.outputFormat,
      keyFile: args.keyFile,
      cwd: process.cwd(),
      dryRun: args.dryRun,
      require3DModel: true,
    }).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : "CodeGoblin 3D command failed.",
    }))
    if (!result.ok) {
      console.error(result.message)
      process.exitCode = 1
      return
    }
    console.log(result.message)
  },
} satisfies CommandModule<object, Args>
