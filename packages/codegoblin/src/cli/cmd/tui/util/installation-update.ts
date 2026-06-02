import type { useDialog } from "@tui/ui/dialog"
import type { useKV } from "../../context/kv"
import type { useSDK } from "../../context/sdk"
import type { useToast } from "../../ui/toast"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { DialogConfirm } from "@tui/ui/dialog-confirm"

export const UPDATE_AVAILABLE_KV_KEY = "update_available_version"
export const SKIPPED_VERSION_KV_KEY = "skipped_version"

type Dialog = ReturnType<typeof useDialog>
type KV = ReturnType<typeof useKV>
type SDK = ReturnType<typeof useSDK>
type Toast = ReturnType<typeof useToast>

export function markUpdateAvailable(kv: KV, version: string) {
  kv.set(UPDATE_AVAILABLE_KV_KEY, version)
}

export function clearUpdateAvailable(kv: KV) {
  kv.set(UPDATE_AVAILABLE_KV_KEY, undefined)
}

export async function performInstallationUpdate(input: {
  version: string
  dialog: Dialog
  kv: KV
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
      message: result.error ? String(result.error) : "Update failed",
      duration: 10000,
    })
    return
  }

  clearUpdateAvailable(kv)

  await DialogAlert.show(
    dialog,
    "Update Complete",
    `Successfully updated CodeGoblin to v${result.data.version}. Please restart the application.`,
  )

  exit()
}
