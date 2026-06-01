import { Button } from "@codegoblin/ui/button"
import { useDialog } from "@codegoblin/ui/context/dialog"
import { Dialog } from "@codegoblin/ui/dialog"
import { List } from "@codegoblin/ui/list"
import { TextField } from "@codegoblin/ui/text-field"
import { showToast } from "@codegoblin/ui/toast"
import { Component, createSignal, Show } from "solid-js"
import type { CodeGoblinMemoryEntry } from "@codegoblin/sdk/v2"
import { useSDK } from "@/context/sdk"

const scopeLabels: Record<CodeGoblinMemoryEntry["scope"], string> = {
  user: "User",
  project: "Project",
  session: "Session",
}

function preview(content: string) {
  const oneLine = content.replace(/\s+/g, " ").trim()
  return oneLine.length > 80 ? oneLine.slice(0, 79) + "…" : oneLine
}

export const DialogMemory: Component = () => {
  const sdk = useSDK()
  const dialog = useDialog()
  const [reloadKey, setReloadKey] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  const fetchItems = async (filter: string) => {
    reloadKey()
    const result = await sdk.client.memory.list({
      query: filter || undefined,
      includeArchived: "true",
    })
    if (result.error) {
      showToast({ variant: "error", icon: "circle-x", title: "Failed to load memories" })
      return []
    }
    return (result.data ?? []) as CodeGoblinMemoryEntry[]
  }

  const refresh = () => setReloadKey((x) => x + 1)

  const togglePin = async (entry: CodeGoblinMemoryEntry) => {
    if (busy()) return
    setBusy(true)
    const result = await sdk.client.memory.pin({ id: entry.id, pinned: !entry.pinned })
    setBusy(false)
    if (result.error) {
      showToast({ variant: "error", icon: "circle-x", title: "Failed to update memory" })
      return
    }
    refresh()
  }

  const toggleArchive = async (entry: CodeGoblinMemoryEntry) => {
    if (busy()) return
    setBusy(true)
    const result = entry.archived
      ? await sdk.client.memory.restore({ id: entry.id })
      : await sdk.client.memory.remove({ id: entry.id })
    setBusy(false)
    if (result.error) {
      showToast({ variant: "error", icon: "circle-x", title: "Failed to update memory" })
      return
    }
    refresh()
  }

  return (
    <Dialog title="Memory" description="Pin (P), archive/restore (X), or add new memories.">
      <List
        search={{ placeholder: "Search memories…", autofocus: true }}
        emptyMessage="No memories yet."
        key={(x) => x.id}
        items={fetchItems}
        add={{
          render: () => (
            <Button
              size="small"
              variant="ghost"
              icon="plus-small"
              class="self-start"
              onClick={() => dialog.show(() => <DialogMemoryAdd onSaved={refresh} />)}
            >
              Add a memory
            </Button>
          ),
        }}
        onKeyEvent={(event, item) => {
          if (!item) return
          if (event.key.toLowerCase() === "p") {
            event.preventDefault()
            void togglePin(item)
            return
          }
          if (event.key.toLowerCase() === "x") {
            event.preventDefault()
            void toggleArchive(item)
          }
        }}
      >
        {(entry) => (
          <div class="w-full flex items-center justify-between gap-x-3">
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="truncate">{preview(entry.content)}</span>
              <div class="flex items-center gap-2 text-11-regular text-text-weaker">
                <span>{scopeLabels[entry.scope]}</span>
                <Show when={entry.pinned}>
                  <span>· pinned</span>
                </Show>
                <Show when={entry.archived}>
                  <span>· archived</span>
                </Show>
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              <Button
                size="small"
                variant="ghost"
                disabled={busy()}
                onClick={() => void togglePin(entry)}
              >
                {entry.pinned ? "Unpin" : "Pin"}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={busy()}
                onClick={() => void toggleArchive(entry)}
              >
                {entry.archived ? "Restore" : "Archive"}
              </Button>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}

const DialogMemoryAdd: Component<{ onSaved: () => void }> = (props) => {
  const sdk = useSDK()
  const dialog = useDialog()
  const [content, setContent] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)

  const save = async (event: Event) => {
    event.preventDefault()
    const value = content().trim()
    if (!value) {
      setError("Memory content is required.")
      return
    }
    setSaving(true)
    setError(undefined)
    const result = await sdk.client.memory.add({ scope: "project", content: value })
    setSaving(false)
    if (result.error) {
      const message =
        typeof result.error === "object" && result.error
          ? "error" in result.error && typeof (result.error as { error?: unknown }).error === "string"
            ? String((result.error as { error: unknown }).error)
            : "message" in result.error && typeof (result.error as { message?: unknown }).message === "string"
              ? String((result.error as { message: unknown }).message)
              : "Memory rejected."
          : "Memory rejected."
      setError(message)
      return
    }
    showToast({ variant: "success", icon: "circle-check", title: "Memory saved" })
    props.onSaved()
    dialog.show(() => <DialogMemory />)
  }

  return (
    <Dialog title="Add a memory" description="Stored at project scope.">
      <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-4">
        <TextField
          autofocus
          label="Memory"
          placeholder="Remember that…"
          value={content()}
          onChange={setContent}
          validationState={error() ? "invalid" : undefined}
          error={error()}
        />
        <Button class="self-start" type="submit" size="large" variant="primary" disabled={saving()}>
          {saving() ? "Saving…" : "Save"}
        </Button>
      </form>
    </Dialog>
  )
}
