import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { useKV } from "../context/kv"
import {
  AudioFormatOptions,
  MediaSettingsDefaults,
  MediaSettingsKeys,
  readAudioSettings,
  readImageSettings,
} from "./media-settings"

// Settings dialogs for /image and /audio. Each row toggles or edits a default
// stored in KV so it persists across sessions. Re-rendering after each change
// is done by re-opening the dialog via dialog.replace.

export function DialogImageSettings() {
  const dialog = useDialog()
  const kv = useKV()
  const settings = readImageSettings(kv)

  const options: DialogSelectOption<string>[] = [
    {
      title: `Output directory: ${settings.outputDir}`,
      description: "Where generated images are saved (relative to the project root).",
      value: "output",
    },
    {
      title: `Auto-approve generation: ${settings.autoApprove ? "on" : "off"}`,
      description: "Skip the confirmation prompt before generating an image.",
      value: "auto",
    },
    {
      title: "Reset to defaults",
      value: "reset",
    },
  ]

  return (
    <DialogSelect
      title="Image settings"
      options={options}
      onSelect={(option) => {
        switch (option.value) {
          case "output":
            dialog.replace(() => (
              <DialogPrompt
                title="Image output directory"
                placeholder="codegoblin-output/images"
                value={settings.outputDir}
                onConfirm={(value) => {
                  kv.set(MediaSettingsKeys.imageOutputDir, value.trim() || MediaSettingsDefaults.imageOutputDir)
                  dialog.replace(() => <DialogImageSettings />)
                }}
                onCancel={() => dialog.replace(() => <DialogImageSettings />)}
              />
            ))
            break
          case "auto":
            kv.set(MediaSettingsKeys.imageAutoApprove, !settings.autoApprove)
            dialog.replace(() => <DialogImageSettings />)
            break
          case "reset":
            kv.set(MediaSettingsKeys.imageOutputDir, MediaSettingsDefaults.imageOutputDir)
            kv.set(MediaSettingsKeys.imageAutoApprove, MediaSettingsDefaults.imageAutoApprove)
            dialog.replace(() => <DialogImageSettings />)
            break
        }
      }}
    />
  )
}

export function DialogAudioSettings() {
  const dialog = useDialog()
  const kv = useKV()
  const settings = readAudioSettings(kv)

  const options: DialogSelectOption<string>[] = [
    {
      title: `Voice: ${settings.voice || "auto (account voice)"}`,
      description: "ElevenLabs voice id. Leave empty to auto-select a generated voice.",
      value: "voice",
    },
    {
      title: `Output format: ${settings.format}`,
      description: "Cycle through common ElevenLabs output formats.",
      value: "format",
    },
    {
      title: `Auto-approve generation: ${settings.autoApprove ? "on" : "off"}`,
      description: "Skip the confirmation prompt before generating audio.",
      value: "auto",
    },
    {
      title: "Reset to defaults",
      value: "reset",
    },
  ]

  return (
    <DialogSelect
      title="Audio settings"
      options={options}
      onSelect={(option) => {
        switch (option.value) {
          case "voice":
            dialog.replace(() => (
              <DialogPrompt
                title="ElevenLabs voice id"
                placeholder="leave empty for auto"
                value={settings.voice}
                onConfirm={(value) => {
                  kv.set(MediaSettingsKeys.audioVoice, value.trim())
                  dialog.replace(() => <DialogAudioSettings />)
                }}
                onCancel={() => dialog.replace(() => <DialogAudioSettings />)}
              />
            ))
            break
          case "format": {
            const idx = AudioFormatOptions.indexOf(settings.format as (typeof AudioFormatOptions)[number])
            const next = AudioFormatOptions[(idx + 1) % AudioFormatOptions.length]
            kv.set(MediaSettingsKeys.audioFormat, next)
            dialog.replace(() => <DialogAudioSettings />)
            break
          }
          case "auto":
            kv.set(MediaSettingsKeys.audioAutoApprove, !settings.autoApprove)
            dialog.replace(() => <DialogAudioSettings />)
            break
          case "reset":
            kv.set(MediaSettingsKeys.audioVoice, MediaSettingsDefaults.audioVoice)
            kv.set(MediaSettingsKeys.audioFormat, MediaSettingsDefaults.audioFormat)
            kv.set(MediaSettingsKeys.audioAutoApprove, MediaSettingsDefaults.audioAutoApprove)
            dialog.replace(() => <DialogAudioSettings />)
            break
        }
      }}
    />
  )
}
