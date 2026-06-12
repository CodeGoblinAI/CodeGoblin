import { Process } from "@/util/process"
import { which } from "@/util/which"

export type PickDirectoryResult = { ok: true; paths: string[] } | { ok: false; message: string }

/** Quote a string for safe interpolation inside a PowerShell single-quoted literal. */
export function powershellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Opens the host machine's native folder picker and returns the selected absolute path(s).
 *
 * Server-backed because the browser File System Access API cannot expose absolute OS paths,
 * and CodeGoblin needs a real path to open a project. Only meaningful when the browser and
 * the CLI server share a machine (the web client gates this behind `server.isLocal()`).
 *
 * Returns `{ ok: true, paths: [] }` when the user cancels, and `{ ok: false }` when no native
 * picker is available so the caller can fall back to the in-app directory dialog.
 */
export async function pickCodeGoblinDirectory(input: {
  title?: string
  multiple?: boolean
  startDir?: string
  /** Injectable for tests; defaults to the real process runner. */
  run?: typeof Process.run
  /** Injectable for tests; defaults to the real PATH lookup. */
  whichFn?: typeof which
}): Promise<PickDirectoryResult> {
  const title = (input.title ?? "Select a folder").replace(/[\r\n"]/g, " ").trim() || "Select a folder"
  const startDir = input.startDir?.trim()
  const run = input.run ?? Process.run
  const whichFn = input.whichFn ?? which

  try {
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null;",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
        `$dialog.Description = ${powershellSingleQuote(title)};`,
        "$dialog.ShowNewFolderButton = $true;",
        startDir ? `$dialog.SelectedPath = ${powershellSingleQuote(startDir)};` : "",
        // Anchor to a hidden top-most form so the dialog comes to the foreground.
        "$anchor = New-Object System.Windows.Forms.Form; $anchor.TopMost = $true; $anchor.ShowInTaskbar = $false; $anchor.Opacity = 0; $anchor.Show(); $anchor.Activate();",
        "$result = $dialog.ShowDialog($anchor); $anchor.Dispose();",
        "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
      ]
        .filter(Boolean)
        .join(" ")
      const result = await run(["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
        nothrow: true,
      })
      const picked = result.stdout.toString("utf8").trim()
      return { ok: true, paths: picked ? [picked] : [] }
    }

    if (process.platform === "darwin") {
      const prompt = title.replace(/"/g, '\\"')
      const osa = input.multiple
        ? `set chosen to choose folder with prompt "${prompt}" with multiple selections allowed\nset out to ""\nrepeat with item_ in chosen\nset out to out & POSIX path of item_ & "\\n"\nend repeat\nreturn out`
        : `POSIX path of (choose folder with prompt "${prompt}")`
      const result = await run(["osascript", "-e", osa], { nothrow: true })
      if (result.code !== 0) return { ok: true, paths: [] }
      const paths = splitLines(result.stdout.toString("utf8"))
      return { ok: true, paths }
    }

    const zenity = whichFn("zenity")
    if (zenity) {
      const args = ["--file-selection", "--directory", `--title=${title}`]
      if (input.multiple) args.push("--multiple", "--separator=\n")
      if (startDir) args.push(`--filename=${startDir.replace(/\/?$/, "/")}`)
      const result = await run([zenity, ...args], { nothrow: true })
      if (result.code !== 0) return { ok: true, paths: [] }
      return { ok: true, paths: splitLines(result.stdout.toString("utf8")) }
    }

    const kdialog = whichFn("kdialog")
    if (kdialog) {
      const result = await run([kdialog, "--getexistingdirectory", startDir || "."], { nothrow: true })
      if (result.code !== 0) return { ok: true, paths: [] }
      const picked = result.stdout.toString("utf8").trim()
      return { ok: true, paths: picked ? [picked] : [] }
    }

    return { ok: false, message: "No native folder picker is available. Install zenity or kdialog, or type the path." }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not open the folder picker." }
  }
}

function splitLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}
