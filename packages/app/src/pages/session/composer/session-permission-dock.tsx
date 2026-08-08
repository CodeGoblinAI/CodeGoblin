import { For, Show } from "solid-js"
import type { PermissionRequest } from "@codegoblin/sdk/v2"
import { Button } from "@codegoblin/ui/button"
import { DockPrompt } from "@codegoblin/ui/dock-prompt"
import { Icon } from "@codegoblin/ui/icon"
import { useLanguage } from "@/context/language"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject" | "never") => void
}) {
  const language = useLanguage()
  const workspaceTrust = () => props.request.permission === "workspace_trust"
  const workspaceProvider = () =>
    typeof props.request.metadata?.provider === "string" ? props.request.metadata.provider : "Local CLI"
  const cursorWorkspaceTrust = () => workspaceTrust() && workspaceProvider() === "Cursor Agent"
  const directory = () => {
    const value = props.request.metadata?.directory
    return typeof value === "string" ? value : props.request.patterns[0]
  }

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <Show
          when={workspaceTrust()}
          fallback={
            <>
              <div />
              <div data-slot="permission-footer-actions">
                <Button
                  variant="ghost"
                  size="normal"
                  onClick={() => props.onDecide("never")}
                  disabled={props.responding}
                >
                  {language.t("ui.permission.denyAlways")}
                </Button>
                <Button
                  variant="ghost"
                  size="normal"
                  onClick={() => props.onDecide("reject")}
                  disabled={props.responding}
                >
                  {language.t("ui.permission.deny")}
                </Button>
                <Button
                  variant="secondary"
                  size="normal"
                  onClick={() => props.onDecide("always")}
                  disabled={props.responding}
                >
                  {language.t("ui.permission.allowAlways")}
                </Button>
                <Button
                  variant="primary"
                  size="normal"
                  onClick={() => props.onDecide("once")}
                  disabled={props.responding}
                >
                  {language.t("ui.permission.allowOnce")}
                </Button>
              </div>
            </>
          }
        >
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              Cancel
            </Button>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {cursorWorkspaceTrust() ? "Trust once" : "Trust folder"}
            </Button>
            <Show when={cursorWorkspaceTrust()}>
              <Button
                variant="primary"
                size="normal"
                onClick={() => props.onDecide("always")}
                disabled={props.responding}
              >
                Always trust
              </Button>
            </Show>
          </div>
        </Show>
      }
    >
      <Show when={workspaceTrust()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">
            {workspaceProvider()} can execute code and access files in this folder.{" "}
            {cursorWorkspaceTrust()
              ? "CodeGoblin can remember an exact-folder approval."
              : "Claude stores this approval."}
          </div>
        </div>
      </Show>

      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={workspaceTrust() ? directory() : props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <Show
              when={workspaceTrust()}
              fallback={
                <For each={props.request.patterns}>
                  {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
                </For>
              }
            >
              <code class="text-12-regular text-text-base break-all">{directory()}</code>
            </Show>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
