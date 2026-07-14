import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"

export function providerLogoutOptions(credentials: string[], providers: { id: string; name: string }[]) {
  return credentials
    .map((providerID) => ({
      title: providers.find((provider) => provider.id === providerID)?.name ?? providerID,
      value: providerID,
      description: providerID,
    }))
    .toSorted((a, b) => a.title.localeCompare(b.title))
}

export function DialogProviderLogout(props: {
  credentials: string[]
  providers: { id: string; name: string }[]
  onRemove: (providerID: string) => void
}) {
  const dialog = useDialog()
  return (
    <DialogSelect
      title="Remove saved credentials"
      options={providerLogoutOptions(props.credentials, props.providers).map((provider) => ({
        ...provider,
        async onSelect() {
          const confirmed = await DialogConfirm.show(
            dialog,
            `Log out of ${provider.title}?`,
            `This removes the saved credential for ${provider.value}. You can reconnect it later with /connect.`,
          )
          if (!confirmed) return
          props.onRemove(provider.value)
        },
      }))}
    />
  )
}
