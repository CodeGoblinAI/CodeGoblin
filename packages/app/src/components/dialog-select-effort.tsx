import { createMemo, Show, type Component } from "solid-js"
import { Dialog } from "@codegoblin/ui/dialog"
import { List } from "@codegoblin/ui/list"
import { useDialog } from "@codegoblin/ui/context/dialog"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"

export const DialogSelectEffort: Component<{ title?: string }> = (props) => {
  const local = useLocal()
  const dialog = useDialog()
  const language = useLanguage()
  const items = createMemo(() => ["default", ...local.model.variant.list()])

  return (
    <Dialog title={props.title ?? "Select effort"} description="Choose a provider-supported reasoning level.">
      <Show
        when={local.model.variant.list().length > 0}
        fallback={<div class="p-4 text-13-regular text-text-weak">The current model does not expose effort controls.</div>}
      >
        <List
          search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
          items={items}
          key={(item) => item}
          current={local.model.variant.current() ?? "default"}
          filterKeys={[]}
          onSelect={(item) => {
            local.model.variant.set(item === "default" ? undefined : item)
            dialog.close()
          }}
        >
          {(item) => <div class="w-full flex items-center justify-between"><span>{item}</span><Show when={item === local.model.variant.current()}><span class="text-text-weak">current</span></Show></div>}
        </List>
      </Show>
    </Dialog>
  )
}
