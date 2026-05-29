import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { useDialog } from "@tui/ui/dialog"
import { CodeGoblinBrand } from "@/codegoblin/brand"
import { codeGoblinProviderSummary } from "@/codegoblin/provider"
import { CodeGoblinImageCommand } from "@/codegoblin/image-command"
import { useProject } from "@tui/context/project"

type HubEntry = "status" | "usage" | "models" | "balance" | "identity"

const ENTRIES: DialogSelectOption<HubEntry>[] = [
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
    description: "Hosted wallet balance (scaffolded)",
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
        if (option.value === "status") {
          dialog.replace(() => (
            <DialogAlert
              title={CodeGoblinBrand.product}
              message={`${CodeGoblinBrand.mascot}\n${CodeGoblinBrand.tagline}\n\nImage prompts route to local files when an image model is selected. Try: create an image of a cat. Outputs land under codegoblin-output/images unless you pass --output.\n\nThe goblin eats token spend and writes the receipt to codegoblin-output/usage.json.\n\n${CodeGoblinBrand.disclaimer}`}
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
          dialog.replace(() => (
            <DialogAlert
              title="CodeGoblin Balance"
              message="Hosted wallet balance is scaffolded only. Future endpoint: GET /v1/me/balance. No hosted subscription secrets or pricing logic are committed."
            />
          ))
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
