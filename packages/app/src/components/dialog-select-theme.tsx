import { createMemo, onCleanup, onMount, Show, type Component } from "solid-js"
import { Dialog } from "@codegoblin/ui/dialog"
import { List } from "@codegoblin/ui/list"
import { useDialog } from "@codegoblin/ui/context/dialog"
import { useTheme } from "@codegoblin/ui/theme/context"
import { resolveThemeVariant } from "@codegoblin/ui/theme/resolve"
import { useLanguage } from "@/context/language"

export const DialogSelectTheme: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const theme = useTheme()
  const items = createMemo(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  onMount(() => {
    void theme.loadThemes()
  })

  onCleanup(() => {
    theme.cancelPreview()
  })

  return (
    <Dialog title="Switch theme" description="Choose the interface theme." size="large">
      <List
        search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
        items={items}
        key={(item) => item.id}
        current={items().find((item) => item.id === theme.themeId())}
        filterKeys={["name"]}
        onMove={(item) => {
          if (!item) {
            theme.cancelPreview()
            return
          }
          theme.previewTheme(item.id)
        }}
        onSelect={(item) => {
          if (!item) return
          theme.setTheme(item.id)
          theme.cancelPreview()
          dialog.close()
        }}
      >
        {(item) => {
          const colors = () => {
            const selected = theme.themes()[item.id]
            if (!selected) return
            return resolveThemeVariant(
              theme.mode() === "dark" ? selected.dark : selected.light,
              theme.mode() === "dark",
            )
          }

          return (
            <div class="w-full flex items-center gap-3">
              <div
                aria-hidden="true"
                class="flex h-7 w-14 shrink-0 items-center gap-1 rounded-md border px-1.5"
                style={{
                  "background-color": colors()?.["background-base"] ?? "var(--background-base)",
                  "border-color": colors()?.["border-weak-base"] ?? "var(--border-weak-base)",
                }}
              >
                <span
                  class="h-3 w-3 rounded-full"
                  style={{ "background-color": colors()?.["icon-interactive-base"] ?? "var(--icon-interactive-base)" }}
                />
                <span
                  class="h-1.5 flex-1 rounded-full"
                  style={{ "background-color": colors()?.["text-base"] ?? "var(--text-base)" }}
                />
                <span
                  class="h-1.5 w-2 rounded-full"
                  style={{ "background-color": colors()?.["text-weak"] ?? "var(--text-weak)" }}
                />
              </div>
              <span class="min-w-0 flex-1 truncate">{item.name}</span>
              <Show when={item.id === theme.themeId()}>
                <span class="shrink-0 text-text-weak">current</span>
              </Show>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
