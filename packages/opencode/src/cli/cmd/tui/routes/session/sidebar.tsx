import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"

function isChatGoblinEnabled(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function TuiSidebarTokenGoblin(props: { theme: any }) {
  const skinColor = RGBA.fromInts(154, 219, 53)
  const shadowColor = RGBA.fromInts(120, 125, 135)
  const vestColor = RGBA.fromInts(130, 80, 223)
  const eyeColor = props.theme.backgroundElement
  const tokenColor = props.theme.warning
  const [tick, setTick] = createSignal(0)

  interface ChatGoblinVariant {
    id: string
    name: string
    frames: string[][]
  }

  const chatGoblinVariants: ChatGoblinVariant[] = [
    {
      id: "01",
      name: "nibble pip",
      frames: [
        ["....S..S.....", "...SGGGGS....", "..SGBBBBGT...", ".SGPPPPPGTT..", "..GGPPMPGG...", "...GPPPPG....", "..G.G..G.....", ".G...G..G...."],
        ["....S..S.....", "...SGGGGS....", "..SGBBBBGGT..", "..GGPPPPPGT..", "...GGPMPGT...", "...GPPPGG....", "..G..GG......", ".G...G......."],
        ["....S..S.....", "...SGGGGS....", "..SGBBBBT....", ".SGPPPPPGG...", "..GGPPMPGG...", "...GPPPPG....", "..G.G..G.....", ".G...G..G...."],
        ["....S..S.....", "...SGGGGS....", "..SGBBBBG....", ".SGPPPPPGG...", "..GGPPMPGG...", "...GPPPGG....", "..G..GG......", ".G...G......."],
      ],
    },
    {
      id: "02",
      name: "crouch munch",
      frames: [
        ["...P..P......", "..PGGGGGP....", ".PGBBBBGGT...", "PGPPPPPPGTT..", ".GGPPMPPGG...", "..GGPPPPG....", "...G.G.G.....", "..G..G..G...."],
        ["...P..P......", "..PGGGGGP....", ".PGBBBBGGTT..", ".GGPPPPPGT...", "..GGPMPGT....", "...GPPPGG....", "..G.G.G......", ".G..G........"],
        ["...P..P......", "..PGGGGGP....", ".PGBBBBGT....", "PGPPPPPPGG...", ".GGPPMPPGG...", "..GGPPPPG....", "...G.G.G.....", "..G..G..G...."],
        ["...P..P......", "..PGGGGGP....", ".PGBBBBGG....", "PGPPPPPPGG...", ".GGPPMPGG....", "..GPPPGGG....", "..G.G.G......", ".G...G......."],
      ],
    },
    {
      id: "03",
      name: "satchel chew",
      frames: [
        [".....S.......", "...SGGGS.....", "..SGBBBGTT...", ".SGPPPPGMM...", "..GGPPPGM....", "...GPPPG.....", "..G.G.G......", ".G..G..G....."],
        [".....S.......", "...SGGGS.....", "..SGBBBGGT...", ".SGPPPPGMMT..", "...GPPPGM....", "..GGPGGG.....", "...G.G.......", "..G..G......."],
        [".....S.......", "...SGGGS.....", "..SGBBBGT....", ".SGPPPPGMM...", "..GGPPPGM....", "...GPPPG.....", "..G.G.G......", ".G..G..G....."],
        [".....S.......", "...SGGGS.....", "..SGBBBGG....", ".SGPPPPGMM...", "..GPPPPGM....", "...GPGGG.....", "..G..G.......", ".G...G......."],
      ],
    },
    {
      id: "04",
      name: "hood pip eater",
      frames: [
        ["...P....P....", "..PGGGGGGP...", ".PGBBBBGGGT..", "PGGPPPPPGGT..", ".GGPPMPPGG...", "..GPPPPPG....", ".G.G..G.G....", "G...G..G....."],
        ["...P....P....", "..PGGGGGGP...", ".PGBBBBGGTT..", "..GGPPPPGGT..", "...GGPMPGT...", "..GPPPPGG....", ".G..GG.G.....", "..G...G......"],
        ["...P....P....", "..PGGGGGGP...", ".PGBBBBGT....", "PGGPPPPPGG...", ".GGPPMPPGG...", "..GPPPPPG....", ".G.G..G.G....", "G...G..G....."],
        ["...P....P....", "..PGGGGGGP...", ".PGBBBBGG....", "PGGPPPPPGG...", ".GGPPMPPGG...", "..GPPPGGG....", ".G..GG.G.....", "..G...G......"],
      ],
    },
    {
      id: "05",
      name: "compact deluxe munch",
      frames: [
        ["..S..P..S....", ".SGGGGGGGS...", "SGBBBMBGGTT..", ".GGPPPPPGGT..", "..GGPMPPGG...", ".G.GPPPPG....", "..G.G.G.G....", "...G...G....."],
        ["..S..P..S....", ".SGGGGGGGS...", "SGBBBMBGGT...", "..GGPPPPPGT..", "...GGPMPGT...", "..GGPPPGG....", "...G.G.G.....", "..G...G......"],
        ["..S..P..S....", ".SGGGGGGGS...", "SGBBBMBGT....", ".GGPPPPPGG...", "..GGPMPPGG...", ".G.GPPPPG....", "..G.G.G.G....", "...G...G....."],
        ["..S..P..S....", ".SGGGGGGGS...", "SGBBBMBGG....", ".GGPPPPPGG...", "..GPPMPPGG...", ".G.GPPPGG....", "..G..G.G.....", "...G..G......"],
      ],
    },
  ]

  function normalizeChatGoblinVariantId(value: string | undefined) {
    const cleaned = value?.trim().replace(/^v/i, "")
    const numeric = Number(cleaned)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= chatGoblinVariants.length) {
      return String(numeric).padStart(2, "0")
    }
    return "04"
  }

  function normalizeFrames(frames: string[][]) {
    const height = Math.max(...frames.map((frame) => frame.length))
    const width = Math.max(...frames.flatMap((frame) => frame.map((row) => row.length)))
    return frames.map((frame) => Array.from({ length: height }, (_, rowIndex) => (frame[rowIndex] ?? "").padEnd(width, ".")))
  }

  const selectedVariantId = normalizeChatGoblinVariantId(process.env.CODEGOBLIN_CHAT_GOBLIN_VARIANT)
  const selectedVariant =
    chatGoblinVariants.find((variant) => variant.id === selectedVariantId) ??
    chatGoblinVariants.find((variant) => variant.id === "04") ??
    chatGoblinVariants[0]
  const frames = normalizeFrames(selectedVariant.frames)
  const width = Math.max(...frames.flatMap((frame) => frame.map((row) => row.length)))

  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    timer = setInterval(() => setTick((value) => value + 1), 220)
    timer?.unref?.()
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  function renderRow(rowIndex: number) {
    const frame = frames[tick() % frames.length] ?? frames[0] ?? []
    const spriteRow = frame[rowIndex] ?? "".padEnd(width, ".")
    const cells: JSX.Element[] = []

    for (const char of spriteRow) {
      if (char === "G") {
        cells.push(<text fg={skinColor}>██</text>)
      } else if (char === "S") {
        cells.push(<text fg={shadowColor}>██</text>)
      } else if (char === "P") {
        cells.push(<text fg={vestColor}>██</text>)
      } else if (char === "B") {
        cells.push(<text fg={eyeColor}>██</text>)
      } else if (char === "M") {
        cells.push(<text fg={props.theme.textMuted}>██</text>)
      } else if (char === "T") {
        cells.push(<text fg={tokenColor}>██</text>)
      } else {
        cells.push(<text>  </text>)
      }
    }

    return cells
  }

  return (
    <box flexDirection="column" alignItems="center" paddingTop={1} paddingBottom={1}>
      {Array.from({ length: frames[0]?.length ?? 0 }, (_, rowIndex) => (
        <box flexDirection="row" width={width * 2}>
          {renderRow(rowIndex)}
        </box>
      ))}
    </box>
  )
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const showChatGoblin = createMemo(() => isChatGoblinEnabled(process.env.CODEGOBLIN_CHAT_GOBLIN))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <TuiPluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </TuiPluginRuntime.Slot>
            <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <Show when={showChatGoblin()}>
          <box flexShrink={0} paddingTop={1}>
            <TuiSidebarTokenGoblin theme={theme} />
          </box>
        </Show>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Code</b>
              <span style={{ fg: theme.text }}>
                <b>Goblin</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </TuiPluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
