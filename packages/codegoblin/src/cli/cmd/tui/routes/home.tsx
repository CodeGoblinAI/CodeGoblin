import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { useEditorContext } from "@tui/context/editor"
import { useTheme } from "../context/theme"
import { RGBA } from "@opentui/core"
import { HEADER_FONTS, SMALL_WORDMARK } from "./home-wordmarks"

function TuiGoblinHeader(props: { theme: any }) {
  const skinColor = RGBA.fromInts(154, 219, 53)
  const goldColor = RGBA.fromInts(245, 200, 75)
  const dimensions = useTerminalDimensions()

  // Pad a block of figlet lines to equal width so they centre cleanly as one unit.
  const padBlock = (rows: string[]) => {
    const width = Math.max(0, ...rows.map((line) => line.length))
    return rows.map((line) => line.padEnd(width, " "))
  }
  // The wordmark font is selectable via CODEGOBLIN_HEADER_FONT
  // (standard | big | slant | shadow | block | mega). On terminals too narrow for the chosen
  // font, fall back to the compact wordmark so it never clips.
  const fontKey = (process.env.CODEGOBLIN_HEADER_FONT ?? "shadow").trim().toLowerCase()
  const wideWordmark = padBlock(HEADER_FONTS[fontKey] ?? HEADER_FONTS.big)
  const smallWordmark = padBlock(SMALL_WORDMARK)

  // Pick the largest wordmark that fits the terminal width; re-runs on resize so it never clips.
  const lines = createMemo(() => {
    const width = Math.max(1, dimensions().width)
    const wordmark = width >= wideWordmark[0].length + 4 ? wideWordmark : smallWordmark
    const rule = "─".repeat(wordmark[0].length)
    return [
      ...wordmark.map((line) => <text fg={skinColor}>{line}</text>),
      <text fg={goldColor}>{rule}</text>,
    ]
  })

  return <box flexDirection="column" alignItems="center">{lines()}</box>
}

function TuiGoblinRunner(props: { theme: any }) {
  const dimensions = useTerminalDimensions()
  const skinColor = RGBA.fromInts(154, 219, 53)
  const shadowColor = RGBA.fromInts(120, 125, 135)
  const vestColor = RGBA.fromInts(130, 80, 223)
  const eyeColor = props.theme.backgroundElement
  const [tick, setTick] = createSignal(0)

  interface RunnerVariant {
    id: string
    name: string
    frames: string[][]
  }

  const runnerVariants: RunnerVariant[] = [
    {
      id: "01",
      name: "tiny classic",
      frames: [
        [".G..G.", "GGGGGG", "GGBBGG", ".GGGG.", ".GPPG.", "G...G."],
        [".G..G.", "GGGGGG", "GGBBGG", ".GGGG.", ".GPPG.", ".GGGG."],
        [".G..G.", "GGGGGG", "GGBBGG", ".GGGG.", ".GGPG.", ".G..G."],
        [".G..G.", "GGGGGG", "GGBBGG", ".GGGG.", ".GPPG.", "G.G.G."],
      ],
    },
    {
      id: "02",
      name: "micro scout",
      frames: [
        ["..S..S..", ".GGGGGG.", "SGGBBGGS", ".GGGGGG.", "..GPPG..", ".G..G.G."],
        ["..S..S..", ".GGGGGG.", "SGGBBGGS", ".GGGGGG.", "..GGPG..", "..GGGG.."],
        ["..S..S..", ".GGGGGG.", "SGGBBGGS", ".GGGGGG.", ".GPPGG..", ".G.G..G."],
        ["..S..S..", ".GGGGGG.", "SGGBBGGS", ".GGGGGG.", "..GPPGG.", "..G..G.."],
      ],
    },
    {
      id: "03",
      name: "round bobber",
      frames: [
        ["..S....S..", ".SGGGGGGS.", "SGGGBBGGGS", ".GGGGGGGG.", "..GPPPGG..", ".G..G.G..."],
        ["..S....S..", ".SGGGGGGS.", "SGGGBBGGGS", ".GGGGGGGG.", "..GGPPGG..", "...GGG...."],
        ["..S....S..", ".SGGGGGGS.", "SGGGBBGGGS", ".GGGGGGGG.", ".GGPPPG...", "..G.G..G.."],
        ["..S....S..", ".SGGGGGGS.", "SGGGBBGGGS", ".GGGGGGGG.", "..GPPPGG..", ".G.G...G.."],
      ],
    },
    {
      id: "04",
      name: "hooded runner",
      frames: [
        ["..P....P..", ".PGGGGGGP.", "PGGGBBGGGP", ".GGGGGGGG.", "..GPPPGG..", ".G..G.G..."],
        ["..P....P..", ".PGGGGGGP.", "PGGGBBGGGP", ".GGGGGGGG.", "..GGPPGG..", "...GGG...."],
        ["..P....P..", ".PGGGGGGP.", "PGGGBBGGGP", "..GGGGGG..", ".GGPPPG...", "..G.G..G.."],
        ["..P....P..", ".PGGGGGGP.", "PGGGBBGGGP", ".GGGGGGGG.", "..GPPPGG..", ".G.G...G.."],
      ],
    },
    {
      id: "05",
      name: "big ear scout",
      frames: [
        ["S...GGGG...S", ".SGGGGGGGGS.", "GGGGBBGGBGGG", ".GGGGGGGGGG.", "..GGPPPPGG..", ".G.G..G..G.."],
        ["S...GGGG...S", ".SGGGGGGGGS.", "GGGGBBGGBGGG", ".GGGGGGGGGG.", "...GPPPGG...", "..GG..GG...."],
        ["S...GGGG...S", ".SGGGGGGGGS.", "GGGGBBGGBGGG", "..GGGGGGGG..", "..GGPPPPG...", "...G.G..GG.."],
        ["S...GGGG...S", ".SGGGGGGGGS.", "GGGGBBGGBGGG", ".GGGGGGGGGG.", "..GGPPPPGG..", ".GG...G.G..."],
      ],
    },
    {
      id: "06",
      name: "sneaksnout",
      frames: [
        ["...S.......", "..SGGGS....", ".SGGBBGGG..", "SGGGPPPGG..", "..GGPPG....", ".G..G.G...."],
        ["...S.......", "..SGGGS....", ".SGGBBGGG..", "SGGGPPPG...", "..GPPGG....", "...GG......"],
        ["...S.......", "..SGGGS....", ".SGGBBGGG..", "SGGGPPPGG..", ".GGPPG.....", "..G.G..G..."],
        ["...S.......", "..SGGGS....", ".SGGBBGGG..", "SGGGPPPG...", "..GGPPG....", ".G...G....."],
      ],
    },
    {
      id: "07",
      name: "rogue dagger",
      frames: [
        ["..S.....MM...", ".SGGGGGGMM...", "SGGGBBGGGM...", ".GGPPPPGMM...", "..GGPPGG.....", ".G..G.G......"],
        ["..S.....MM...", ".SGGGGGGMM...", "SGGGBBGGGM...", ".GGPPPPGMM...", "..GPPGG......", "...GG........"],
        ["..S.....MM...", ".SGGGGGGMM...", "SGGGBBGGGM...", "GGGPPPPGGM...", "..GGPPG......", ".G.G..G......"],
        ["..S.....MM...", ".SGGGGGGMM...", "SGGGBBGGGM...", ".GGPPPPGMM...", "..GGPPGG.....", ".G....G......"],
      ],
    },
    {
      id: "08",
      name: "scar hood",
      frames: [
        ["..P....P..", ".PGGGGGGP.", "PGGBMBGGGP", ".GGGPPGGG.", "..GGPPGG..", ".G.G..G..."],
        ["..P....P..", ".PGGGGGGP.", "PGGBMBGGGP", ".GGGPPGGG.", "...GPPG...", "..GG..GG.."],
        ["..P....P..", ".PGGGGGGP.", "PGGBMBGGGP", ".GGGPPGGG.", ".GGPPPG...", "...G.G..G."],
        ["..P....P..", ".PGGGGGGP.", "PGGBMBGGGP", ".GGGPPGGG.", "..GGPPGG..", ".G...G.G.."],
      ],
    },
    {
      id: "09",
      name: "squat bruiser",
      frames: [
        [".SGGGGGS.", "SGGBBGGGS", "GGGPPPGGG", ".GGPPPGG.", "G.G...G.G"],
        [".SGGGGGS.", "SGGBBGGGS", "GGGPPPGGG", "..GGPG...", ".GG..GG.."],
        [".SGGGGGS.", "SGGBBGGGS", "GGGPPPGGG", ".GGPPGG..", "..G.G..G."],
        [".SGGGGGS.", "SGGBBGGGS", "GGGPPPGGG", "..GGPPG..", ".G...G.G."],
      ],
    },
    {
      id: "10",
      name: "deluxe goblin",
      frames: [
        ["..S....S....", ".SGGGGGGGS..", "SGGGBMMBGGGS", ".GGGGGGGGGG.", "..GGPPPPGG..", "...GPPG.....", ".G.G..G..G.."],
        ["..S....S....", ".SGGGGGGGS..", "SGGGBMMBGGGS", ".GGGGGGGGGG.", "...GGPPGG...", "....GGG.....", "..GG..GG...."],
        ["..S....S....", ".SGGGGGGGS..", "SGGGBMMBGGGS", ".GGGGGGGGGG.", "..GGPPPPG...", "...GPPGG....", ".G..G..G.G.."],
        ["..S....S....", ".SGGGGGGGS..", "SGGGBMMBGGGS", ".GGGGGGGGGG.", "...GPPPGG...", "..GGPG......", ".G.G...G...."],
      ],
    },
    {
      id: "11",
      name: "lean sneak",
      frames: [
        ["..S.....", ".SGGG...", "SGGBBG..", ".GGPPGG.", "..GPPG..", ".G..G.G."],
        ["..S.....", ".SGGG...", "SGGBBG..", ".GGPPGG.", "..GGPG..", "..GGGG.."],
        ["..S.....", ".SGGG...", "SGGBBG..", ".GGPPG..", "...GPGG.", ".G.G..G."],
        ["..S.....", ".SGGG...", "SGGBBG..", ".GGPPGG.", "..GPPGG.", ".G...G.."],
      ],
    },
    {
      id: "12",
      name: "pickpocket",
      frames: [
        ["...S.....", "..SGGG...", ".SGGBBG..", "SGGPPPGG.", "..GPPPG..", ".G..G.G.."],
        ["...S.....", "..SGGG...", ".SGGBBG..", "SGGPPPG..", "..GGPPG..", "...GGGG.."],
        ["...S.....", "..SGGG...", ".SGGBBG..", "SGGPPPGG.", ".GGPPG...", "..G.G..G."],
        ["...S.....", "..SGGG...", ".SGGBBG..", ".GGPPPGG.", "..GPPGG..", ".G...G.G."],
      ],
    },
    {
      id: "13",
      name: "mini nib",
      frames: [
        [".S.....", "SGGG...", "GGBBG..", ".GPPGG.", "..GPG..", ".G..G.."],
        [".S.....", "SGGG...", "GGBBG..", ".GPPGG.", "..GGG..", "..G.G.."],
        [".S.....", "SGGG...", "GGBBG..", ".GGPG..", "...PPGG", ".G.G..."],
        [".S.....", "SGGG...", "GGBBG..", ".GPPGG.", "..GPG..", ".G...G."],
      ],
    },
    {
      id: "14",
      name: "crouch hop",
      frames: [
        ["..S....", ".SGGG..", "SGGBGG.", ".GPPPG.", "..GGG..", ".G.G..."],
        ["..S....", ".SGGG..", "SGGBGG.", ".GPPPG.", "...GG..", "..G.G.."],
        ["..S....", ".SGGG..", "SGGBGG.", ".GGPPG.", "..GPG..", ".G..G.."],
        ["..S....", ".SGGG..", "SGGBGG.", ".GPPPG.", "..GGPG.", ".G.G..."],
      ],
    },
    {
      id: "15",
      name: "hunched runner",
      frames: [
        ["...S....", "..SGGG..", ".SGGBGG.", "SGGPPPG.", "..GPPGG.", ".G.G..G."],
        ["...S....", "..SGGG..", ".SGGBGG.", "SGGPPPG.", "...GGPG.", "..GGG..."],
        ["...S....", "..SGGG..", ".SGGBGG.", ".GGPPPGG", "..GPPG..", ".G..G.G."],
        ["...S....", "..SGGG..", ".SGGBGG.", "SGGPPPG.", "..GGPGG.", ".G...G.."],
      ],
    },
    {
      id: "16",
      name: "satchel scout",
      frames: [
        ["..S......", ".SGGG....", "SGGBBG...", ".GGPPGGMM", "..GPPGMM.", ".G..G...."],
        ["..S......", ".SGGG....", "SGGBBG...", ".GGPPGGMM", "..GGPGMM.", "..GG....."],
        ["..S......", ".SGGG....", "SGGBBG...", ".GGPPG.MM", "...GPGGMM", ".G.G....."],
        ["..S......", ".SGGG....", "SGGBBG...", ".GGPPGGMM", "..GPPGMM.", ".G...G..."],
      ],
    },
    {
      id: "17",
      name: "hood pip",
      frames: [
        ["..P....", ".PGGG..", "PGGBG..", ".GPPGG.", "..GPG..", ".G.G..."],
        ["..P....", ".PGGG..", "PGGBG..", ".GPPGG.", "..GGG..", "..G.G.."],
        ["..P....", ".PGGG..", "PGGBG..", ".GGPG..", "...PPGG", ".G..G.."],
        ["..P....", ".PGGG..", "PGGBG..", ".GPPGG.", "..GPG..", ".G...G."],
      ],
    },
    {
      id: "18",
      name: "low bruiser",
      frames: [
        [".SGGGG..", "SGGBBG..", "GGPPPPG.", ".GGPPGG.", "G.G..G.."],
        [".SGGGG..", "SGGBBG..", "GGPPPPG.", "..GPPG..", ".GGGG..."],
        [".SGGGG..", "SGGBBG..", "GGPPPPGG", ".GGPPG..", "..G.G.G."],
        [".SGGGG..", "SGGBBG..", "GGPPPPG.", "..GGPGG.", ".G...G.."],
      ],
    },
    {
      id: "19",
      name: "crooknose",
      frames: [
        ["...S.....", "..SGGG...", ".SGBBGG..", "SGGPPPGG.", "..GGPG...", ".G..G.G.."],
        ["...S.....", "..SGGG...", ".SGBBGG..", "SGGPPPG..", "..GPPG...", "...GGGG.."],
        ["...S.....", "..SGGG...", ".SGBBGG..", ".GGPPPGG.", "..GPGG...", ".G.G..G.."],
        ["...S.....", "..SGGG...", ".SGBBGG..", "SGGPPPGG.", "..GGPGG..", ".G...G..."],
      ],
    },
    {
      id: "20",
      name: "compact deluxe",
      frames: [
        ["..S..S..", ".SGGGGG.", "SGGBMBGG", ".GGPPPG.", "..GPPGG.", ".G..G.G."],
        ["..S..S..", ".SGGGGG.", "SGGBMBGG", ".GGPPPG.", "..GGPG..", "..GGGG.."],
        ["..S..S..", ".SGGGGG.", "SGGBMBGG", ".GGPPPG.", ".GGPPG..", ".G.G..G."],
        ["..S..S..", ".SGGGGG.", "SGGBMBGG", ".GGPPPG.", "..GPPGG.", ".G...G.."],
      ],
    },
  ]

  function normalizeRunnerVariantId(value: string | undefined) {
    const cleaned = value?.trim().replace(/^v/i, "")
    const numeric = Number(cleaned)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= runnerVariants.length) {
      return String(numeric).padStart(2, "0")
    }
    return "12"
  }

  function normalizeRunnerFrames(frames: string[][]) {
    const height = Math.max(...frames.map((frame) => frame.length))
    const width = Math.max(...frames.flatMap((frame) => frame.map((row) => row.length)))
    return frames.map((frame) => Array.from({ length: height }, (_, rowIndex) => (frame[rowIndex] ?? "").padEnd(width, ".")))
  }

  const selectedRunnerVariantId = normalizeRunnerVariantId(process.env.CODEGOBLIN_FOOTER_VARIANT)
  const selectedRunnerVariant =
    runnerVariants.find((variant) => variant.id === selectedRunnerVariantId) ??
    runnerVariants.find((variant) => variant.id === "12") ??
    runnerVariants[0]
  const rightRunnerFrames = normalizeRunnerFrames(selectedRunnerVariant.frames)
  const leftRunnerFrames = rightRunnerFrames.map((frame) => frame.map((runnerRow) => [...runnerRow].reverse().join("")))

  const spriteHeight = rightRunnerFrames[0]?.length ?? 0
  const spriteWidth = Math.max(...rightRunnerFrames.flatMap((frame) => frame.map((runnerRow) => runnerRow.length)))
  const laneCells = () => {
    const availableChars = Math.max(12, dimensions().width - 8)
    return Math.max(spriteWidth + 4, Math.min(32, Math.floor(availableChars / 2)))
  }
  const laneWidth = () => laneCells() * 2
  const travelSpan = () => Math.max(0, laneCells() - spriteWidth)
  const cycleLength = () => Math.max(1, travelSpan() * 2)
  const movingRight = () => travelSpan() === 0 || (tick() % cycleLength()) < travelSpan()
  const spriteOffset = () => {
    const span = travelSpan()
    if (span <= 0) return 0
    const phase = tick() % (span * 2)
    return phase <= span ? phase : span * 2 - phase
  }

  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    timer = setInterval(() => setTick((value) => value + 1), 120)
    timer?.unref?.()
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  function renderRunnerRow(rowIndex: number) {
    const frameSet = movingRight() ? rightRunnerFrames : leftRunnerFrames
    const frame = frameSet[tick() % frameSet.length] ?? frameSet[0] ?? []
    const spriteRow = frame[rowIndex] ?? "".padEnd(spriteWidth, ".")
    const offset = spriteOffset()
    const trailStart = movingRight()
      ? Math.max(0, offset - 2)
      : Math.min(laneCells(), offset + spriteWidth)
    const trailEnd = movingRight()
      ? Math.max(0, offset)
      : Math.min(laneCells(), offset + spriteWidth + 2)
    const cells: JSX.Element[] = []

    for (let cell = 0; cell < laneCells(); cell++) {
      const spriteColumn = cell - offset
      const char = spriteColumn >= 0 && spriteColumn < spriteRow.length ? spriteRow[spriteColumn] : "."

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
      } else if (rowIndex === spriteHeight - 1 && cell >= trailStart && cell < trailEnd) {
        cells.push(<text fg={shadowColor}>░░</text>)
      } else {
        cells.push(<text>  </text>)
      }
    }

    return cells
  }

  return (
    <box flexDirection="column" alignItems="center" width="100%" flexShrink={0}>
      {Array.from({ length: spriteHeight }, (_, rowIndex) => (
        <box flexDirection="row" width={laneWidth()}>
          {renderRunnerRow(rowIndex)}
        </box>
      ))}
      <box flexDirection="row" width={laneWidth()}>
        <text fg={shadowColor}>{"▁".repeat(laneWidth())}</text>
      </box>
    </box>
  )
}

function isFooterAnimationEnabled(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

let once = false
const placeholder = {
  normal: ["Dig up a buried TODO", "Map out this project's stack", "Mend the broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const { theme } = useTheme()
  const showFooterAnimation = isFooterAnimationEnabled(process.env.CODEGOBLIN_FOOTER_ANIMATION)
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (runnerPrompt: PromptRef | undefined) => {
    setRef(runnerPrompt)
    promptRef.set(runnerPrompt)
    if (once || !runnerPrompt) return
    if (route.prompt) {
      runnerPrompt.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    runnerPrompt.set({ input: args.prompt, parts: [] })
    once = true
  }

  createEffect(() => {
    const runnerPrompt = ref()
    if (sent) return
    if (!runnerPrompt) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (runnerPrompt.current.input !== args.prompt) return
    sent = true
    runnerPrompt.submit()
  })

  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={2} minHeight={0} />
        <box flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            <TuiGoblinHeader theme={theme} />
          </TuiPluginRuntime.Slot>
        </box>
        <box height={3} minHeight={0} flexShrink={0} />
        {showFooterAnimation ? <TuiGoblinRunner theme={theme} /> : null}
        <TuiPluginRuntime.Slot name="home_bottom" />
        <box height={1} minHeight={0} flexShrink={0} />
        <box width="100%" maxWidth={130} minHeight={3} zIndex={1000} flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<TuiPluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
          </TuiPluginRuntime.Slot>
        </box>
        <box flexGrow={2} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
