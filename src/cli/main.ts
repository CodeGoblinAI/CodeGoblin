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
    // Installed through npm, `upgrade` never gets this far: the launcher carries it out before the program
    // starts, because a running program cannot be replaced on Windows. This is the program started by itself.
    console.log(`CodeGoblin ${InstallationVersion}\nThis copy was started directly, so it cannot replace itself. To update:\n  npm install -g @codegoblin-io/codegoblin@latest`)
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
    if (asked.name === "voice") await (await import("../core/voice-worker")).serve()
    else if (asked.name === "reaper") (await import("../platform/reaper")).serve()
    else await import("../core/cursor-worker")
    break
  case "unknown":
    console.error(`${command}: there is no option ${asked.option}. ${command} --help lists what there is.`)
    process.exit(2)
  case "tui":
    // The terminal app draws on a screen and reads keys. Started with its input or output going somewhere
    // else - a pipe, a file, a script - it used to draw its screen into that and wait for keys that never came.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(`${command} opens an app in the terminal, and this is not a terminal (its input or output goes somewhere else).
For one prompt without a terminal:  ${command} run "<prompt>"`)
      process.exit(1)
    }
    hand(asked.args)
    await import("../tui/app")
    break
}
