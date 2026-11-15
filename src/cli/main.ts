#!/usr/bin/env bun
/**
 * The one command: `codegoblin` (and `cg`). Works out what was asked for and loads only that part - the
 * terminal app, the web server and the one-shot prompt each start as they are loaded.
 */
import { route, helpText } from "./route"
import { InstallationVersion } from "../platform/version"

const asked = route(process.argv.slice(2))
const command = process.env.CODEGOBLIN_CLI_NAME || "codegoblin"
/** The part being loaded reads process.argv itself, so it is handed its own arguments without our word in front. */
const hand = (args: string[]) => { process.argv = [process.argv[0]!, process.argv[1]!, ...args] }

switch (asked.kind) {
  case "version":
    console.log(InstallationVersion)
    break
  case "help":
    console.log(helpText(command, InstallationVersion))
    break
  case "upgrade":
    console.log(`Updating from inside the app is not built yet. To update: npm install -g @codegoblin-io/codegoblin@latest`)
    break
  case "web":
    hand(asked.args)
    await import("../web/serve")
    break
  case "run":
    hand(asked.args)
    await import("./prompt")
    break
  case "worker":
    if (asked.name === "voice") await import("../core/voice-worker")
    else await import("../core/cursor-worker")
    break
  case "tui":
    hand(asked.args)
    await import("../tui/app")
    break
}
