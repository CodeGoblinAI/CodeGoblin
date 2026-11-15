/**
 * The files the web app sends to the browser, as paths that work both from source and inside the built
 * program. Imported as files: from source each is the real file on disk (so an edit shows on reload); built,
 * each is carried inside the program. They used to be looked up next to the source, which the built program
 * does not have - every page answered with an error.
 */
import page from "./index.html" with { type: "file" }
import appJs from "./app.js" with { type: "file" }
import logo from "./logo.png" with { type: "file" }
import xtermJs from "../../node_modules/@xterm/xterm/lib/xterm.js" with { type: "file" }
import xtermCss from "../../node_modules/@xterm/xterm/css/xterm.css" with { type: "file" }
import addonFit from "../../node_modules/@xterm/addon-fit/lib/addon-fit.js" with { type: "file" }

export const ASSETS = { page, appJs, logo, xtermJs, xtermCss, addonFit } as unknown as Record<"page" | "appJs" | "logo" | "xtermJs" | "xtermCss" | "addonFit", string>
