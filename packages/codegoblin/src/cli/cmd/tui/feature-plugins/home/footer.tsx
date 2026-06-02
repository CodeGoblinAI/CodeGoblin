import type { TuiPlugin, TuiPluginApi } from "@codegoblin/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import semver from "semver"
import { InstallationVersion } from "@codegoblin/core/installation/version"
import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { Global } from "@codegoblin/core/global"
import { markUpdateAvailable, UPDATE_AVAILABLE_KV_KEY } from "../../util/installation-update"

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const dir = createMemo(() => {
    const dir = props.api.state.path.directory || process.cwd()
    const out = dir.replace(Global.Path.home, "~")
    const branch = props.api.state.vcs?.branch
    if (branch) return out + ":" + branch
    return out
  })

  return <text fg={theme().textMuted}>{dir()}</text>
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [updateVersion, setUpdateVersion] = createSignal<string | undefined>(
    props.api.kv.get(UPDATE_AVAILABLE_KV_KEY, undefined),
  )

  onMount(() => {
    const stop = props.api.event.on("installation.update-available", (evt) => {
      markUpdateAvailable(props.api.kv, evt.properties.version)
      setUpdateVersion(evt.properties.version)
    })
    onCleanup(stop)
  })

  const showUpdate = createMemo(() => {
    const latest = updateVersion()
    if (!latest) return false
    if (!semver.valid(latest) || !semver.valid(InstallationVersion)) return true
    return semver.gt(latest, InstallationVersion)
  })

  return (
    <box flexDirection="row" flexShrink={0} gap={1}>
      <text fg={theme().textMuted}>{props.api.app.version}</text>
      <Show when={showUpdate()}>
        <text fg={theme().warning}>↑ v{updateVersion()} · codegoblin update</text>
      </Show>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory api={props.api} />
      <Mcp api={props.api} />
      <box flexGrow={1} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
