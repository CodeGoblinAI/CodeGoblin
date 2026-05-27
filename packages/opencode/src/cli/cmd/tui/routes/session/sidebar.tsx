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

export const SESSION_SIDEBAR_WIDTH = 46

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

  type GoblinFrameCycle = [string, string, string, string]
  type GoblinRow = string | GoblinFrameCycle

  function cycle(row: GoblinRow): GoblinFrameCycle {
    return typeof row === "string" ? [row, row, row, row] : row
  }

  function createChatGoblinVariant(id: string, name: string, rows: GoblinRow[]): ChatGoblinVariant {
    const cycledRows = rows.map(cycle)
    return {
      id,
      name,
      frames: Array.from({ length: 4 }, (_, frameIndex) => cycledRows.map((row) => row[frameIndex])),
    }
  }

  const menuHeadSmall: GoblinRow[] = [
    "....GGGG....",
    "..GGGGGGGG..",
    "G.GGGGGGGG.G",
    ".GGGGGGGGGG.",
    ["..GGBBGGBG..", "..GGBBGGBGT.", "..GGBBGGBT..", "..GGBBGGBG.."],
    ["..GGBBGGBG..", "..GGGBWWBG..", "..GGGBBBGT..", "..GGBBGGBG.."],
    "...GGGGGG...",
  ]

  const menuHeadWide: GoblinRow[] = [
    ".....GGGG.....",
    "...GGGGGGGG...",
    "G..GGGGGGGG..G",
    ".GGGGGGGGGGGG.",
    ["..GGGBBGGBGG..", "..GGGBBGGBGGT.", "..GGGBBGGBT...", "..GGGBBGGBGG.."],
    ["..GGGBBGGBGG..", "..GGGGBWWBGG..", "..GGGGBBBGTT..", "..GGGBBGGBGG.."],
    "....GGGGGG....",
  ]

  const menuHeadSlim: GoblinRow[] = [
    "...GGGG...",
    "..GGGGGG..",
    "G.GGGGGG.G",
    ".GGGGGGGG.",
    [".GGBBGBG..", ".GGBBGBGT.", ".GGBBGBT..", ".GGBBGBG.."],
    [".GGBBGBG..", ".GGGBWBG..", ".GGGBBGT..", ".GGBBGBG.."],
    "..GGGGGG..",
  ]

  const profileHead: GoblinRow[] = [
    "....GGGGG....",
    "..GGGGGGGGG..",
    ".GGGGGGGGGGT.",
    "GGGGGGGGGGTT",
    [".GGGBBGGGGT.", ".GGGBBGGGTT", ".GGGBBGGTT.", ".GGGBBGGGG."],
    ["..GGGBBBGG..", "..GGGBWWG..", "..GGGBBGT..", "..GGGBGG..."],
    "...GGGGG....",
  ]

  const chatGoblinVariants: ChatGoblinVariant[] = [
    createChatGoblinVariant("01", "gate snap", [
      ".....S..S........",
      "...SGGGGGS.......",
      ["..SGGGBBBGGS.....", "..SGGGBBBGGT.....", "..SGGGBBBGT......", "..SGGGBBBGG......"],
      [".SGGGGGGGGGGT....", ".SGGGGGPPPGGT....", ".SGGGGPPPPGTT....", ".SGGGGGPPGGG....."],
      ["SGGPPPMMMMPGGTT..", "SGGPPPMMMMPPGG...", "SGGPPPMMMMPGG....", "SGGPPPMMMPPGG...."],
      [".GGPPPPPPPGGG....", ".GGPPPPPPGGG.....", ".GGPPPPPPGGG.....", ".GGPPPPPGGG......"],
      "..GGGGGGGGG......",
      "...G..GG..G......",
    ]),
    createChatGoblinVariant("02", "long-ear gulp", [
      "...S......S......",
      "..SGGGGGGGS......",
      [".SGGGGBBBGGS.....", ".SGGGGBBBGGT.....", ".SGGGGBBBGT......", ".SGGGGBBBGG......"],
      ["SGGGGGGGGGGGT....", "SGGGGGPPPGGGT....", "SGGGGPPPPGGTT....", "SGGGGGPPPGGG....."],
      ["GGPPPPMMMMPGGTT..", "GGPPPPMMMMPPGG...", "GGPPPPMMMMPGG....", "GGPPPPMMMPPGG...."],
      [".GGPPPPPPPGGG....", ".GGPPPPPPGGG.....", ".GGPPPPPPGGG.....", ".GGPPPPPGGG......"],
      "..GGGGGGGG.......",
      ".G...GG...G......",
    ]),
    createChatGoblinVariant("03", "hood maw", [
      "....PSSSSP.......",
      "..PPGGGGGGP......",
      [".PGGGBBBBGGP.....", ".PGGGBBBBGGT.....", ".PGGGBBBBGT......", ".PGGGBBBBGG......"],
      ["SGGGGGGGGGGTT....", "SGGGGGPPPGGTT....", "SGGGGPPPPGTT.....", "SGGGGGPPGGG......"],
      ["GGPPPPMMMMPGG....", "GGPPPPMMMMPPG....", "GGPPPPMMMMPGG....", "GGPPPPMMMPPG....."],
      [".GGPPPPPPPGG.....", ".GGPPPPPPGG......", ".GGPPPPPPGG......", ".GGPPPPPGGG......"],
      "..GGGGGGGG.......",
      "...G..GG.........",
    ]),
    createChatGoblinVariant("04", "token chomper", [
      ".....SPS.........",
      "...SGGGGGPS......",
      ["..SGGGBBBGGS.....", "..SGGGBBBGGTT....", "..SGGGBBBGTT.....", "..SGGGBBBGGG....."],
      [".SGGGGGGGGGGTT...", ".SGGGGGPPPGGTT...", ".SGGGGPPPPGTT....", ".SGGGGGPPGGG....."],
      ["SGGPPPMMMMPGGTT..", "SGGPPPMMMMPPGG...", "SGGPPPMMMMPGG....", "SGGPPPMMMPPGG...."],
      [".GGPPPPPPPGGG....", ".GGPPPPPPGGG.....", ".GGPPPPPPGGG.....", ".GGPPPPPGGG......"],
      "..GGGGGGGGG......",
      "...G.G..G.G......",
    ]),
    createChatGoblinVariant("05", "cave grinner", [
      "....SSSS.........",
      "..SSGGGGGS.......",
      [".SGGGGBBBGGS.....", ".SGGGGBBBGGT.....", ".SGGGGBBBGT......", ".SGGGGBBBGG......"],
      ["SGGGGGMMMMGGTT...", "SGGGGGPPMMGGTT...", "SGGGGPPPMMGTT....", "SGGGGGPMMGGG....."],
      ["GGPPPPPPPPGG.....", "GGPPPPPPPPGG.....", "GGPPPPPPPGGG.....", "GGPPPPPPGGG......"],
      [".GGPPPPPPGG......", ".GGPPPPPGG.......", ".GGPPPPPGGG......", ".GGPPPPGGG......."],
      "..GGGGGGGG.......",
      "...G..GG.........",
    ]),
    createChatGoblinVariant("06", "bat-ear chew", [
      "..S..S..S..S.....",
      ".SGGGGGGGGGS.....",
      ["SGGGGBBBBGGGS....", "SGGGGBBBBGGTT....", "SGGGGBBBBGTT.....", "SGGGGBBBBGGG....."],
      ["GGGGGGGGGGGGTT...", "GGGGGGPPPGGGTT...", "GGGGGPPPPGGTT....", "GGGGGGPPPGGG....."],
      ["SGPPPPMMMMPGGT...", "SGPPPPMMMMPPGG...", "SGPPPPMMMMPGG....", "SGPPPPMMMPPGG...."],
      [".GGPPPPPPGGG.....", ".GGPPPPPPGG......", ".GGPPPPPPGGG.....", ".GGPPPPPGGG......"],
      "..GGGGGGGG.......",
      "...G.G..G........",
    ]),
    createChatGoblinVariant("07", "crown crunch", [
      "....SPSPS........",
      "..SGGGGGGGS......",
      [".SGGGBBBBGGS.....", ".SGGGBBBBGGT.....", ".SGGGBBBBGT......", ".SGGGBBBBGG......"],
      ["SGGGGGGGGGGGT....", "SGGGGGPPPGGGT....", "SGGGGPPPPGGTT....", "SGGGGGPPPGGG....."],
      ["GGPPPMMMMPGGTT...", "GGPPPMMMMPPGG....", "GGPPPMMMMPGG.....", "GGPPPMMMPPGG....."],
      [".GGPPPPPPPGG.....", ".GGPPPPPPGG......", ".GGPPPPPPGG......", ".GGPPPPPGGG......"],
      "..GGGGGGGGG......",
      "...G..GG.........",
    ]),
    createChatGoblinVariant("08", "heavy jaw", [
      ".....SSS.........",
      "...SGGGGGGS......",
      ["..SGGGBBBBGGS....", "..SGGGBBBBGGT....", "..SGGGBBBBGTT....", "..SGGGBBBBGGG...."],
      [".SGGGGGGGGGGGT...", ".SGGGGGPPPGGGTT...", ".SGGGGPPPPGGTT...", ".SGGGGGPPPGGGG..."],
      ["GGPPPPMMMMPPGGTT.", "GGPPPPMMMMPPGG...", "GGPPPPMMMMPPG....", "GGPPPPMMMMPPG...."],
      [".GGPPPPPPPPGG....", ".GGPPPPPPPGG.....", ".GGPPPPPPPGGG....", ".GGPPPPPPGGG....."],
      "..GGGGGGGGGG.....",
      "...GG...GG.......",
    ]),
    createChatGoblinVariant("09", "sly nib", [
      "......S..S.......",
      "...SSGGGGGGS.....",
      ["..SGGGGBBBGG.....", "..SGGGGBBBGGT....", "..SGGGGBBBGT.....", "..SGGGGBBBGG....."],
      [".SGGGGGGGGGTT....", ".SGGGGGPPPGGT....", ".SGGGGPPPPGTT....", ".SGGGGGPPGGG....."],
      ["SGGPPPMMMPPGGT...", "SGGPPPMMMPPGG....", "SGGPPPMMMPGG.....", "SGGPPPMMMPPG....."],
      [".GGPPPPPPGGG.....", ".GGPPPPPPGG......", ".GGPPPPPPGGG.....", ".GGPPPPPGGG......"],
      "..GGGGGGGG.......",
      "...G...G.........",
    ]),
    createChatGoblinVariant("10", "deluxe maw", [
      "...SP....PS......",
      "..SGGGGGGGGS.....",
      [".SGGGBBBBGGGS....", ".SGGGBBBBGGTT....", ".SGGGBBBBGTT.....", ".SGGGBBBBGGG....."],
      ["SGGGGGGGGGGGTT...", "SGGGGGPPPGGGTT...", "SGGGGPPPPGGTT....", "SGGGGGPPPGGGG...."],
      ["GGPPPPMMMMPGGTT..", "GGPPPPMMMMPPGG...", "GGPPPPMMMMPGG....", "GGPPPPMMMPPGG...."],
      [".GGPPPPPPPGGG....", ".GGPPPPPPGGG.....", ".GGPPPPPPGGG.....", ".GGPPPPPGGG......"],
      "..GGGGGGGGGG.....",
      "...G.G..G.G......",
    ]),
    createChatGoblinVariant("11", "knife grin", [
      "......S....S......",
      "....SGGGGGGGS.....",
      "...SGGBBGBBGGS....",
      ["..SGGGBBBBBGGGT...", "..SGGGBBWWBGGTT...", "..SGGGBBBBBGTT....", "..SGGGBBWWBGGG...."],
      [".SGGGGPPPGGGGT....", ".SGGGPPPPGGGGT....", ".SGGGPPPPGGGT.....", ".SGGGGPPPGGG......"],
      "..SGG.PPP.GG......",
      "...G..GG..G.......",
      "..................",
    ]),
    createChatGoblinVariant("12", "lantern bite", [
      "....S......S......",
      "...SGGGGGGGGS.....",
      ["..SGGBB..BBGG.....", "..SGGBB..BBGGT....", "..SGGBB..BBGT.....", "..SGGBB..BBGG....."],
      [".SGGGGBBBBBGGT....", ".SGGGGBBWWBGGTT...", ".SGGGGBBBBBGTT....", ".SGGGGBBWWBGG....."],
      ["SGGGPPPPPPGGTT....", "SGGGPPPPPGGGT.....", "SGGGPPPPGGG.......", "SGGGPPPGGG........"],
      ".SGGPP..PPGG......",
      "..GG....GG.......",
      "..................",
    ]),
    createChatGoblinVariant("13", "hood profile", [
      "......PSSSP.......",
      "....PPGGGGGP......",
      ["...PGGBBBGGGT.....", "...PGGBBBGGGTT....", "...PGGBBBGGTT.....", "...PGGBBBGGG......"],
      ["..PGGGGBBBBBGTT...", "..PGGGGBBWWBGTT...", "..PGGGGBBBBBGT....", "..PGGGGBBWWBG....."],
      ["..GGPPPPPPGGG.....", "..GGPPPPPGG.......", "..GGPPPPGG........", "..GGPPPGG........."],
      "...GGPPPGG........",
      "....G..G..........",
      "..................",
    ]),
    createChatGoblinVariant("14", "wide tooth", [
      "...S........S.....",
      "..SGGGGGGGGGGS....",
      [".SGGBB....BBGGS...", ".SGGBB....BBGGT...", ".SGGBB....BBGT....", ".SGGBB....BBGG...."],
      ["SGGGGGBBBBBBGGT...", "SGGGGGBWWWWBGTT..", "SGGGGGBBBBBBGTT..", "SGGGGGBWWWWBGG..."],
      [".SGGGPPPPPPGGG....", ".SGGGPPPPPGG......", ".SGGGPPPPGG.......", ".SGGGPPPGG........"],
      "..SGGPP..PPG......",
      "...GG......GG.....",
      "..................",
    ]),
    createChatGoblinVariant("15", "coin inhale", [
      ".....S..S.........",
      "...SGGGGGGGS......",
      ["..SGGBBBBGGT......", "..SGGBBBBGGTT.....", "..SGGBBBBGTT......", "..SGGBBBBGG......."],
      [".SGGGGBBBBBGTT....", ".SGGGGBBWWBGGTT...", ".SGGGGBBBBBGGT....", ".SGGGGBBWWBGG....."],
      ["SGGPPPPPPPGGGTT...", "SGGPPPPPPGGG......", "SGGPPPPPGGG.......", "SGGPPPPGG........."],
      ".GGPPMMPPGG.......",
      "..GG....GG........",
      "..................",
    ]),
    createChatGoblinVariant("16", "imp yawn", [
      "....S..SS..S......",
      "..SGGGGGGGGGS.....",
      [".SGGGBB..BBGGS....", ".SGGGBB..BBGGT....", ".SGGGBB..BBGT.....", ".SGGGBB..BBGG....."],
      ["SGGGGGBBBBBGGTT...", "SGGGGBBWWBBGGTT...", "SGGGGGBBBBBGTT....", "SGGGGBBWWBBGG....."],
      [".GGGPPPPPPGGG.....", ".GGGPPPPPGGG......", ".GGGPPPPGGG.......", ".GGGPPPGGG........"],
      "..GGPP..PPGG......",
      "...G......G.......",
      "..................",
    ]),
    createChatGoblinVariant("17", "skullcap chew", [
      ".....SSSSSS.......",
      "...SSGGGGGGSS.....",
      ["..SGGBBGBBGGGS....", "..SGGBBGBBGGTT....", "..SGGBBGBBGTT.....", "..SGGBBGBBGGG....."],
      [".SGGGGBBBBBGTT....", ".SGGGGBBWWBGTT....", ".SGGGGBBBBBGT.....", ".SGGGGBBWWBG......"],
      ["..GGGPPPPGGG......", "..GGPPPPGG........", "..GGPPPGG.........", "..GGPPGG.........."],
      "...GGPMMGG........",
      "....G..G..........",
      "..................",
    ]),
    createChatGoblinVariant("18", "snout snap", [
      "......S...........",
      "....SGGGGGS.......",
      ["...SGGBBBGGGTT....", "...SGGBBBGGGTTT...", "...SGGBBBGGTT.....", "...SGGBBBGGG......"],
      ["..SGGGGBBBBBGTT...", "..SGGGGBBWWBGGTT..", "..SGGGGBBBBBGT....", "..SGGGGBBWWBG....."],
      ["...GGPPPPPGGG.....", "...GGPPPPGG.......", "...GGPPPGG........", "...GGPPGG........."],
      "....GGPMGG........",
      ".....G..G.........",
      "..................",
    ]),
    createChatGoblinVariant("19", "needle teeth", [
      "....S........S....",
      "..SGGGGGGGGGGS....",
      [".SGGBBGBBGBBGS....", ".SGGBBGBBGBBGT....", ".SGGBBGBBGBBT.....", ".SGGBBGBBGBBG....."],
      ["SGGGGGBBBBBGGTT...", "SGGGGBWBWBWGGTT...", "SGGGGGBBBBBGTT....", "SGGGGBWBWBWGG....."],
      [".SGGPPPPPPGGG.....", ".SGGPPPPPGG.......", ".SGGPPPPGG........", ".SGGPPPGG........."],
      "..SGGPMMPGG.......",
      "...GG....GG.......",
      "..................",
    ]),
    createChatGoblinVariant("20", "clean mascot", [
      ".....S....S.......",
      "...SGGGGGGGGS.....",
      ["..SGGBB..BBGGS....", "..SGGBB..BBGGT....", "..SGGBB..BBGT.....", "..SGGBB..BBGG....."],
      [".SGGGGBBBBBGGT....", ".SGGGGBBWWBGTT....", ".SGGGGBBBBBGT.....", ".SGGGGBBWWBGG....."],
      ["..GGGPPPPPGGG.....", "..GGGPPPPGG.......", "..GGGPPPGG........", "..GGGGPGG........."],
      "...GGPMMPGG.......",
      "....G....G........",
      "..................",
    ]),
    createChatGoblinVariant("21", "menu tiny body", [
      ...menuHeadSmall,
      "....GPPG....",
      "...G.PP.G...",
      "..G......G..",
    ]),
    createChatGoblinVariant("22", "menu thin scout", [
      ...menuHeadSlim,
      "...GPPG...",
      "....PP....",
      "...G..G...",
      "..G....G..",
    ]),
    createChatGoblinVariant("23", "menu chunky hoodie", [
      ...menuHeadWide,
      "..GGPPPPGG..",
      ".GGGPPPPGGG.",
      "GG..PPPP..GG",
      "...G....G...",
    ]),
    createChatGoblinVariant("24", "menu tall lanky", [
      ...menuHeadSmall,
      "....GPPG....",
      "....GPPG....",
      ".....PP.....",
      "....G..G....",
      "...G....G...",
    ]),
    createChatGoblinVariant("25", "menu squat bruiser", [
      ...menuHeadWide,
      ".GGGPPPPGGG.",
      "GGGGPPPPGGGG",
      "..GG....GG..",
    ]),
    createChatGoblinVariant("26", "menu little thief", [
      ...menuHeadSmall,
      ["...GGPPGG..T", "...GGPPGGT.", "...GGPPGT..", "...GGPPGG.."],
      ["..G.PPPP.GT", "..G.PPPGT.", "..G.PPGT..", "..G.PPGG.."],
      "...G....G..",
    ]),
    createChatGoblinVariant("27", "menu cloak triangle", [
      ...menuHeadSmall,
      ".....PP.....",
      "....PPPP....",
      "...PPPPPP...",
      "..G.PPPP.G..",
    ]),
    createChatGoblinVariant("28", "menu big boots", [
      ...menuHeadSmall,
      "....GPPG....",
      "...GGPPGG...",
      "..GG....GG..",
      ".GG......GG.",
    ]),
    createChatGoblinVariant("29", "menu needle thin", [
      ...menuHeadSlim,
      "....PP....",
      "....PP....",
      "...G..G...",
      "...G..G...",
    ]),
    createChatGoblinVariant("30", "menu wide arms", [
      ...menuHeadWide,
      ["GG..GPPG..GG", "GG..GPPG..GT", "G...GPPG.TG", "GG..GPPG..GG"],
      ".G..PPPP..G.",
      "...G....G...",
    ]),
    createChatGoblinVariant("31", "profile bite body", [
      ...profileHead,
      "...GGPPGG...",
      "....GPPG....",
      "...G....G...",
    ]),
    createChatGoblinVariant("32", "profile skinny run", [
      ...profileHead,
      "....GPPG....",
      ".....PP.....",
      "....G..G....",
      "..G......G..",
    ]),
    createChatGoblinVariant("33", "profile heavy pack", [
      ...profileHead,
      "...GGPPGGMM.",
      "..GGPPPPGMM.",
      "...G....G...",
    ]),
    createChatGoblinVariant("34", "menu satchel side", [
      ...menuHeadSmall,
      "...GGPPGGMM.",
      "..G.PPPPGMM.",
      "...G....G...",
    ]),
    createChatGoblinVariant("35", "menu tiny imp", [
      "...GGG...",
      ".GGGGGGG.",
      "GGGGGGGGG",
      [".GGBBGBG.", ".GGBBGBT.", ".GGBBGT..", ".GGBBGBG."],
      [".GGGBGG..", ".GGGBWT..", ".GGGBG...", ".GGGBGG.."],
      "..GPPG...",
      ".G....G..",
    ]),
    createChatGoblinVariant("36", "menu tall robe", [
      ...menuHeadWide,
      "....PPPP....",
      "...PPPPPP...",
      "...PPPPPP...",
      "..G.PPPP.G..",
      ".G........G.",
    ]),
    createChatGoblinVariant("37", "menu thick shell", [
      ...menuHeadWide,
      ".GGGPPPPGGG.",
      "GGGGPPPPGGGG",
      "GGG..PP..GGG",
      "..GG....GG..",
    ]),
    createChatGoblinVariant("38", "menu spare mascot", [
      ...menuHeadSmall,
      ".....PP.....",
      "....P..P....",
      "...G....G...",
    ]),
    createChatGoblinVariant("39", "menu token lunge", [
      ...menuHeadSmall,
      ["...GGPPGG...T", "...GGPPGG..T.", "...GGPPGG.T..", "...GGPPGG...."],
      ["..G.PPPP.G.T", "..G.PPPP.GT.", "..G.PPPPGT..", "..G.PPPPG..."],
      "...G....G...",
    ]),
    createChatGoblinVariant("40", "menu clean body", [
      ...menuHeadWide,
      "...GGPPGG...",
      "..G.PPPP.G..",
      "....G..G....",
      "...G....G...",
    ]),
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
    timer = setInterval(() => setTick((value) => value + 1), 200)
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
      } else if (char === "W") {
        cells.push(<text fg={props.theme.text}>██</text>)
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
        width={SESSION_SIDEBAR_WIDTH}
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
