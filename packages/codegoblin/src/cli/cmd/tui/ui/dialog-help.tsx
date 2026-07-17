import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "./dialog"
import { useBindings, useCommandShortcut } from "../keymap"

type Row = {
  title: string
  /** Command id whose live binding is shown — the list always reflects the user's config. */
  command: string
  /** Shown when the command is unbound or not reachable from the current screen. */
  fallback?: string
}
type Group = { title: string; rows: Row[] }

const GROUPS: Group[] = [
  {
    title: "Essentials",
    rows: [
      { title: "Send message", command: "input.submit" },
      { title: "Insert newline", command: "input.newline" },
      { title: "Interrupt", command: "session.interrupt", fallback: "esc" },
      { title: "Action palette", command: "command.palette.show" },
      { title: "Cycle agent", command: "agent.cycle" },
      { title: "Keyboard shortcuts", command: "help.show", fallback: "/help" },
      { title: "Quit", command: "app.exit" },
    ],
  },
  {
    title: "Input",
    rows: [
      { title: "Clear input", command: "prompt.clear" },
      { title: "Paste (incl. images)", command: "prompt.paste" },
      { title: "Undo in input", command: "input.undo" },
      { title: "Redo in input", command: "input.redo" },
      { title: "Open external editor", command: "prompt.editor" },
    ],
  },
  {
    title: "Conversation",
    rows: [
      { title: "Toggle thinking blocks", command: "session.toggle.thinking", fallback: "/thinking" },
      { title: "Fold / unfold responses", command: "session.toggle.fold", fallback: "/fold" },
      { title: "Scroll page up", command: "session.page.up" },
      { title: "Scroll page down", command: "session.page.down" },
      { title: "First message", command: "session.first" },
      { title: "Last message", command: "session.last" },
      { title: "Next message", command: "session.message.next" },
      { title: "Previous message", command: "session.message.previous" },
      { title: "Jump to last user message", command: "session.messages_last_user" },
      { title: "Copy message", command: "messages.copy" },
      { title: "Toggle timestamps", command: "session.toggle.timestamps", fallback: "/timestamps" },
      { title: "Undo last message", command: "session.undo", fallback: "/undo" },
      { title: "Redo message", command: "session.redo", fallback: "/redo" },
    ],
  },
  {
    title: "Session",
    rows: [
      { title: "New session", command: "session.new" },
      { title: "Resume session", command: "session.list", fallback: "/resume" },
      { title: "Timeline", command: "session.timeline", fallback: "/timeline" },
      { title: "Rename session", command: "session.rename", fallback: "/rename" },
      { title: "Compact session", command: "session.compact", fallback: "/compact" },
      { title: "Toggle sidebar", command: "session.sidebar.toggle" },
      { title: "Export to editor", command: "session.export", fallback: "/export" },
    ],
  },
  {
    title: "Models, modes & theme",
    rows: [
      { title: "Model selector", command: "model.list", fallback: "/model" },
      { title: "Recent model", command: "model.cycle_recent" },
      { title: "Switch model variant", command: "variant.cycle", fallback: "/variants" },
      { title: "Mode selector", command: "agent.list", fallback: "/mode" },
      { title: "Theme selector", command: "theme.switch", fallback: "/theme" },
    ],
  },
]

function ShortcutRow(props: { row: Row }) {
  const { theme } = useTheme()
  const shortcut = useCommandShortcut(props.row.command)
  const display = () => shortcut() || props.row.fallback || "—"

  return (
    <box flexDirection="row" justifyContent="space-between" gap={2}>
      <text fg={theme.text} wrapMode="none">
        {props.row.title}
      </text>
      <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
        {display()}
      </text>
    </box>
  )
}

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close shortcuts", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close shortcuts", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Keyboard shortcuts
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox
        maxHeight={22}
        paddingRight={1}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.backgroundPanel,
            foregroundColor: theme.borderSubtle,
          },
        }}
      >
        <box gap={1} paddingBottom={1}>
          <For each={GROUPS}>
            {(group) => (
              <box>
                <text attributes={TextAttributes.BOLD} fg={theme.textMuted}>
                  {group.title}
                </text>
                <For each={group.rows}>{(row) => <ShortcutRow row={row} />}</For>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>↑/↓ scroll · shortcuts follow your tui.json keybind overrides</text>
      </box>
    </box>
  )
}
