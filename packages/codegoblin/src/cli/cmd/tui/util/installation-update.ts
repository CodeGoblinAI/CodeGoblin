import type { useDialog } from "@tui/ui/dialog"
import type { useSDK } from "../context/sdk"
import type { useToast } from "../ui/toast"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { willUseWindowsUpdateHandoff } from "@/installation/windows-update"

export const UPDATE_AVAILABLE_KV_KEY = "update_available_version"
export const SKIPPED_VERSION_KV_KEY = "skipped_version"

type Dialog = ReturnType<typeof useDialog>
type KVLike = {
  get: (key: string, defaultValue?: any) => any
  set: (key: string, value: any) => void
}
type SDK = ReturnType<typeof useSDK>
type Toast = ReturnType<typeof useToast>

// The SDK surfaces upgrade failures as a structured error object, so a bare
// String(error) rendered "[object Object]" and hid the real cause (e.g. on
// Windows, npm can't overwrite the running codegoblin.exe). Pull out a readable
// message from the shapes the client actually returns.
export function updateErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return error
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "object") {
    const e = error as Record<string, any>
    const nested = e.data?.message ?? e.data?.stderr ?? e.message ?? e.stderr
    if (typeof nested === "string" && nested.trim()) return nested.trim()
    try {
      const json = JSON.stringify(error)
      if (json && json !== "{}") return json
    } catch {}
  }
  return undefined
}

export function markUpdateAvailable(kv: KVLike, version: string) {
  kv.set(UPDATE_AVAILABLE_KV_KEY, version)
}

export function clearUpdateAvailable(kv: KVLike) {
  kv.set(UPDATE_AVAILABLE_KV_KEY, undefined)
}

export async function performInstallationUpdate(input: {
  version: string
  dialog: Dialog
  kv: KVLike
  sdk: SDK
  toast: Toast
  exit: () => void
  confirm?: boolean
}) {
  const { version, dialog, kv, sdk, toast, exit, confirm = true } = input

  if (confirm) {
    const choice = await DialogConfirm.show(
      dialog,
      "Update Available",
      `Install CodeGoblin v${version} now?`,
      "skip",
    )

    if (choice === false) {
      kv.set(SKIPPED_VERSION_KV_KEY, version)
      clearUpdateAvailable(kv)
      return
    }

    if (choice !== true) return
  }

  toast.show({
    variant: "info",
    message: `Updating to v${version}...`,
    duration: 30000,
  })

  const result = await sdk.client.global.upgrade({ target: version })

  if (result.error || !result.data?.success) {
    toast.show({
      variant: "error",
      title: "Update Failed",
      message: updateErrorMessage(result.error) ?? "Update failed. Try `cg update` from a terminal.",
      duration: 12000,
    })
    return
  }

  clearUpdateAvailable(kv)

  if (willUseWindowsUpdateHandoff()) {
    toast.show({
      variant: "success",
      message: `Update prepared. Restarting CodeGoblin...`,
      duration: 3000,
    })
    exit()
    return
  }

  await DialogAlert.show(
    dialog,
    "Update Complete",
    `Successfully updated CodeGoblin to v${result.data.version}. Please restart the application.`,
  )

  exit()
}
