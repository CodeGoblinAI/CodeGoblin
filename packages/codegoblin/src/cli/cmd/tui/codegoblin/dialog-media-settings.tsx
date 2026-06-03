import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { getAudioProvider, listAudioProviders } from "@/codegoblin/audio-providers"
import { useKV } from "../context/kv"
import {
  MediaSettingsDefaults,
  MediaSettingsKeys,
  readAudioSettings,
  readImageSettings,
  readModel3DSettings,
} from "./media-settings"

const MODEL3D_VERSIONS = ["v3.1-20260211", "v3.0-20250812"] as const

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
  const provider = getAudioProvider(settings.provider)
  const formats = provider.outputFormats

  const options: DialogSelectOption<string>[] = [
    {
      title: `Provider: ${provider.name}`,
      description: "Text-to-speech provider used for /audio generation.",
      value: "provider",
    },
    {
      title: `Voice: ${settings.voice || "auto (account voice)"}`,
      description: `${provider.name} voice id. Leave empty to auto-select a voice.`,
      value: "voice",
    },
    {
      title: `Output format: ${settings.format}`,
      description: `Cycle through ${provider.name} output formats.`,
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
          case "provider": {
            const ids = listAudioProviders().map((item) => item.id)
            const idx = ids.indexOf(provider.id)
            const next = getAudioProvider(ids[(idx + 1) % ids.length])
            kv.set(MediaSettingsKeys.audioProvider, next.id)
            kv.set(MediaSettingsKeys.audioFormat, next.defaultOutputFormat)
            kv.set(MediaSettingsKeys.audioVoice, MediaSettingsDefaults.audioVoice)
            dialog.replace(() => <DialogAudioSettings />)
            break
          }
          case "voice":
            dialog.replace(() => (
              <DialogPrompt
                title={`${provider.name} voice id`}
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
            const idx = formats.indexOf(settings.format)
            const next = formats[(idx + 1) % formats.length]
            kv.set(MediaSettingsKeys.audioFormat, next)
            dialog.replace(() => <DialogAudioSettings />)
            break
          }
          case "auto":
            kv.set(MediaSettingsKeys.audioAutoApprove, !settings.autoApprove)
            dialog.replace(() => <DialogAudioSettings />)
            break
          case "reset":
            kv.set(MediaSettingsKeys.audioProvider, MediaSettingsDefaults.audioProvider)
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

export function DialogModel3DSettings() {
  const dialog = useDialog()
  const kv = useKV()
  const settings = readModel3DSettings(kv)

  const options: DialogSelectOption<string>[] = [
    {
      title: `Output directory: ${settings.outputDir}`,
      description: "Where generated 3D models are saved (relative to the project root).",
      value: "output",
    },
    {
      title: `Tripo model version: ${settings.modelVersion}`,
      description: "Cycle through supported Tripo H3 model versions.",
      value: "version",
    },
    {
      title: `Auto-approve generation: ${settings.autoApprove ? "on" : "off"}`,
      description: "Skip the confirmation prompt before generating a 3D model.",
      value: "auto",
    },
    {
      title: "Reset to defaults",
      value: "reset",
    },
  ]

  return (
    <DialogSelect
      title="3D model settings"
      options={options}
      onSelect={(option) => {
        switch (option.value) {
          case "output":
            dialog.replace(() => (
              <DialogPrompt
                title="3D output directory"
                placeholder="codegoblin-output/models"
                value={settings.outputDir}
                onConfirm={(value) => {
                  kv.set(MediaSettingsKeys.model3dOutputDir, value.trim() || MediaSettingsDefaults.model3dOutputDir)
                  dialog.replace(() => <DialogModel3DSettings />)
                }}
                onCancel={() => dialog.replace(() => <DialogModel3DSettings />)}
              />
            ))
            break
          case "version": {
            const idx = MODEL3D_VERSIONS.indexOf(settings.modelVersion as (typeof MODEL3D_VERSIONS)[number])
            const next = MODEL3D_VERSIONS[(idx + 1) % MODEL3D_VERSIONS.length]
            kv.set(MediaSettingsKeys.model3dVersion, next)
            dialog.replace(() => <DialogModel3DSettings />)
            break
          }
          case "auto":
            kv.set(MediaSettingsKeys.model3dAutoApprove, !settings.autoApprove)
            dialog.replace(() => <DialogModel3DSettings />)
            break
          case "reset":
            kv.set(MediaSettingsKeys.model3dOutputDir, MediaSettingsDefaults.model3dOutputDir)
            kv.set(MediaSettingsKeys.model3dAutoApprove, MediaSettingsDefaults.model3dAutoApprove)
            kv.set(MediaSettingsKeys.model3dVersion, MediaSettingsDefaults.model3dVersion)
            dialog.replace(() => <DialogModel3DSettings />)
            break
        }
      }}
    />
  )
}
