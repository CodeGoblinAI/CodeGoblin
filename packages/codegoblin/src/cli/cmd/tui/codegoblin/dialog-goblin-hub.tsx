import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { useDialog } from "@tui/ui/dialog"
import { CodeGoblinBrand } from "@/codegoblin/brand"
import { codeGoblinProviderSummary } from "@/codegoblin/provider"
import { CodeGoblinImageCommand } from "@/codegoblin/image-command"
import { collectRuntimeStatus, formatRuntimeStatus } from "@/codegoblin/runtime-status"
import { CodeGoblinBalance } from "@/codegoblin/balance"
import { useProject } from "@tui/context/project"
import { DialogMemory } from "./dialog-memory"
import { DialogMarket } from "./dialog-market"
import { DialogImageSettings, DialogAudioSettings, DialogModel3DSettings } from "./dialog-media-settings"

type HubEntry = "memory" | "market" | "media-image" | "media-audio" | "media-3d" | "status" | "usage" | "models" | "balance" | "identity"

const ENTRIES: DialogSelectOption<HubEntry>[] = [
  {
    title: "Memory",
    description: "Browse, pin, archive, and add CodeGoblin memories",
    value: "memory",
  },
  {
    title: "Market",
    description: "Add, connect, authenticate, or disconnect MCP servers",
    value: "market",
  },
  {
    title: "Image settings",
    description: "Default image model, size, and output format",
    value: "media-image",
  },
  {
    title: "Audio settings",
    description: "Provider, voice, and output format for audio",
    value: "media-audio",
  },
  {
    title: "3D model settings",
    description: "Tripo version, output directory, and auto-approve for 3D",
    value: "media-3d",
  },
  {
    title: "Status & about",
    description: "What CodeGoblin is and how it routes image/audio prompts",
    value: "status",
  },
  {
    title: "Token hoard",
    description: "Local usage receipt written to codegoblin-output/usage.json",
    value: "usage",
  },
  {
    title: "Hosted models",
    description: "Models CodeGoblin can route to",
    value: "models",
  },
  {
    title: "Balance",
    description: "Live provider balances (deepseek/moonshot) or manual fallback",
    value: "balance",
  },
  {
    title: "Identity & theme",
    description: "Product look, palette, and where to open the theme picker",
    value: "identity",
  },
]

export function DialogGoblinHub() {
  const dialog = useDialog()
  const project = useProject()

  return (
    <DialogSelect
      title={CodeGoblinBrand.product}
      options={ENTRIES}
      onSelect={async (option) => {
        if (option.value === "memory") {
          dialog.replace(() => <DialogMemory />)
          return
        }
        if (option.value === "market") {
          dialog.replace(() => <DialogMarket />)
          return
        }
        if (option.value === "media-image") {
          dialog.replace(() => <DialogImageSettings />)
          return
        }
        if (option.value === "media-audio") {
          dialog.replace(() => <DialogAudioSettings />)
          return
        }
        if (option.value === "media-3d") {
          dialog.replace(() => <DialogModel3DSettings />)
          return
        }
        if (option.value === "status") {
          const runtime = await collectRuntimeStatus()
          dialog.replace(() => (
            <DialogAlert
              title={CodeGoblinBrand.product}
              message={`${CodeGoblinBrand.mascot}\n${CodeGoblinBrand.tagline}\n\n${formatRuntimeStatus(runtime)}\n\nImage prompts route to local files when an image model is selected. 3D models use Tripo when a 3D model is selected.\n\n${CodeGoblinBrand.disclaimer}`}
            />
          ))
          return
        }
        if (option.value === "usage") {
          const summary = await CodeGoblinImageCommand.usageSummary(project.instance.directory() || process.cwd())
          dialog.replace(() => <DialogAlert title="Goblin Hoard" message={summary} />)
          return
        }
        if (option.value === "models") {
          dialog.replace(() => <DialogAlert title="CodeGoblin Models" message={codeGoblinProviderSummary()} />)
          return
        }
        if (option.value === "balance") {
          const result = await CodeGoblinBalance.resolve({ cwd: project.instance.directory() || process.cwd() }).catch(
            () => undefined,
          )
          dialog.replace(() => <DialogAlert title="CodeGoblin Balance" message={formatBalanceMessage(result)} />)
          return
        }
        dialog.replace(() => (
          <DialogAlert
            title="CodeGoblin Identity"
            message="CodeGoblin theme identity shows the product look: custom wordmark, green/black default TUI palette, CG terminal title, and local usage hoard. /themes opens the actual theme picker."
          />
        ))
      }}
    />
  )
}

function formatBalanceMessage(
  result: Awaited<ReturnType<typeof CodeGoblinBalance.resolve>> | undefined,
): string {
  if (!result) return "Could not resolve balances right now. No hosted balance numbers are fabricated."
  const lines: string[] = []
  if (result.balances.length === 0) {
    lines.push(
      "No provider balances are configured. Set a provider API key (DEEPSEEK_API_KEY / MOONSHOT_API_KEY) for live balances,",
      "or set a manual fallback (CODEGOBLIN_DEEPSEEK_BALANCE_USD / CODEGOBLIN_MOONSHOT_BALANCE_USD / CODEGOBLIN_TOKEN_HOARD_USD).",
      "No balance numbers are invented when nothing is configured.",
    )
  } else {
    for (const entry of result.balances) {
      const tag = entry.live ? "live" : "manual"
      const amount = entry.unit === "USD" ? `$${entry.amount.toFixed(2)}` : `${entry.amount} ${entry.unit}`
      lines.push(`${entry.label}: ${amount} · ${tag} (${entry.source})`)
    }
  }
  if (result.errors.length > 0) {
    lines.push("", "Notes:")
    for (const error of result.errors) lines.push(`• ${error.provider}: ${error.message}`)
  }
  return lines.join("\n")
}

