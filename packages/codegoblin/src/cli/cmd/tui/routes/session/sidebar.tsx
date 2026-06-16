import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationChannel, InstallationVersion } from "@codegoblin/core/installation/version"
import type { AssistantMessage } from "@codegoblin/sdk/v2"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import {
  codeGoblinCompanionActionVariant,
  codeGoblinCompanionActivity,
  codeGoblinCompanionActivityVariant,
  codeGoblinCompanionBurnDelta,
  codeGoblinCompanionMode,
  codeGoblinCompanionVisible,
  codeGoblinFlagEnabled,
  type CodeGoblinCompanionBurn,
} from "@/codegoblin/companion"
import { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"

export const SESSION_SIDEBAR_WIDTH = 46

function TuiSidebarCompanionGoblin(props: {
  theme: any
  active: boolean
  contextText: string
  sessionCost: number
  sessionTokens: number
  activityText: string
  activityKind: "idle" | "thinking" | "image" | "audio"
}) {
  const skinColor = RGBA.fromInts(154, 219, 53)
  const shadowColor = RGBA.fromInts(120, 125, 135)
  const vestColor = RGBA.fromInts(130, 80, 223)
  const eyeColor = props.theme.backgroundElement
  const spendColor = props.theme.warning
  const [tick, setTick] = createSignal(0)
  const [lastBurn, setLastBurn] = createSignal<CodeGoblinCompanionBurn | undefined>()
  const [actionStartTick, setActionStartTick] = createSignal<number | undefined>()
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
  const number = new Intl.NumberFormat("en-US")
  let previousSessionCost: number | undefined
  let previousSessionTokens: number | undefined

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

  function staticRow(row: GoblinRow) {
    return typeof row === "string" ? row : row[0]
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
    "....GGGGGGG...",
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
    return "40"
  }

  function normalizeFrames(frames: string[][]) {
    const height = Math.max(...frames.map((frame) => frame.length))
    const width = Math.max(...frames.flatMap((frame) => frame.map((row) => row.length)))
    return frames.map((frame) => Array.from({ length: height }, (_, rowIndex) => (frame[rowIndex] ?? "").padEnd(width, ".")))
  }

  function normalizeChatGoblinFrame(value: string | undefined) {
    const numeric = Number(value?.trim())
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 4) return undefined
    return numeric - 1
  }

  function createCompanionFrame(...rows: string[]) {
    return rows
  }

  const companionHeadWide = menuHeadWide.map(staticRow)
  const companionIdleFrames = normalizeFrames([
    createCompanionFrame(
      ...companionHeadWide,
      "...GGPPGG...",
      "..G.PPPP.G..",
      "....G..G....",
      "...G....G...",
    ),
    createCompanionFrame(
      ...companionHeadWide,
      "...GGPPGG...",
      "..G.PPPP.G..",
      "....G..G....",
      "...G....G...",
    ),
    createCompanionFrame(
      ...companionHeadWide,
      "...GGPPGG...",
      "..G.PPPP.G..",
      "....G..G....",
      "...G....G...",
    ),
    createCompanionFrame(
      ...companionHeadWide,
      "...GGPPGG...",
      "..G.PPPP.G..",
      "....G..G....",
      "...G....G...",
    ),
  ])
  const companionActionFrames = {
    "01": normalizeFrames([
      createCompanionFrame(
        ...companionHeadWide,
        "...GGPPGG..T.",
        "..G.PPPP.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ...companionHeadWide,
        "...GGPPGGT...",
        "..G.PPPP.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ...companionHeadWide,
        "...GGPPTGG...",
        "..G.PPPP.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ...companionHeadWide,
        "...GGTPPGG...",
        "..G.PPPP.G..",
        "....G..G....",
        "...G....G...",
      ),
    ]),
    "02": normalizeFrames([
      createCompanionFrame(
        ...companionHeadWide,
        "...GGWWGG...",
        "..G.WWWW.G..",
        "....GT.G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ...companionHeadWide,
        "...GGWWGG...",
        "..G.WWTW.G..",
        "....GT.G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ...companionHeadWide,
        "...GGWWGG...",
        "..G.WTTW.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ...companionHeadWide,
        "...GGWWGG...",
        "..G.TTTT.G..",
        "....G..G....",
        "...G....G...",
      ),
    ]),
    "03": normalizeFrames([
      createCompanionFrame(
        ...companionHeadWide,
        "...GGPPGG..T.",
        "..G.PPPP.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ".....GGGG.....",
        "...GGGGGGGG..T",
        "G..GGGGGGGG..G",
        ".GGGGGGGGGGGG.",
        "..GGGBBGGBGG..",
        "..GGGBBGGBGG..",
        "....GGGGGGG...",
        "...GGPPGG....",
        "..G.PPPP.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        "....TGGGG.....",
        "...GGGGGGGG...",
        "G..GGGGGGGG..G",
        ".GGGGGGGGGGGG.",
        "..GGGBBGGBGG..",
        "..GGGBBGGBGG..",
        "....GGGGGGG...",
        "...GGPPGG....",
        "..G.PPPP.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ".....GGGG.....",
        "T..GGGGGGGG...",
        "G..GGGGGGGG..G",
        ".GGGGGGGGGGGG.",
        "..GGGBBGGBGG..",
        "..GGGBBGGBGG..",
        "....GGGGGGG...",
        "...GGPPGG....",
        "..G.PPPP.G..",
        "....G..G....",
        "...G....G...",
      ),
    ]),
    "04": normalizeFrames([
      createCompanionFrame(
        ...companionHeadWide,
        "...GGWWGG...",
        "..G.WWWW.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ...companionHeadWide,
        "...GGWWGG...",
        "..G.WTTW.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ...companionHeadWide,
        "...GGTTGG...",
        "..G.TTTT.G..",
        "....G..G....",
        "...G....G...",
      ),
      createCompanionFrame(
        ...companionHeadWide,
        "...GGWWGG...",
        "..G.TTTT.G..",
        "....G..G....",
        "...G....G...",
      ),
    ]),
  } as const
  const companionActivityVariantCatalog = {
    thinking: {
      "01": {
        name: "thought pips",
        summary: "three tiny thought lights rise over the goblin's shoulder",
        frames: normalizeFrames([
          createCompanionFrame(
            ".............W....",
            ...companionHeadWide,
            "...GGPPGG........",
            "..G.PPPP.G.......",
            "....G..G....W....",
            "...G....G..W.....",
          ),
          createCompanionFrame(
            "............WW....",
            ...companionHeadWide,
            "...GGPPGG........",
            "..G.PPPP.G..W....",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            "...........W.W....",
            ...companionHeadWide,
            "...GGPPGG........",
            "..G.PPPP.G.......",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            "............WW....",
            ...companionHeadWide,
            "...GGPPGG........",
            "..G.PPPP.G..W....",
            "....G..G.........",
            "...G....G........",
          ),
        ]),
      },
      "02": {
        name: "chin spark",
        summary: "a little idea spark flickers near the face while one hand lifts",
        frames: normalizeFrames([
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...W....",
            "..G.PPWP.G..T....",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            ".............W....",
            ...companionHeadWide,
            "...GGPPGG..WT....",
            "..G.PPWP.G..W....",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            "............WT....",
            ...companionHeadWide,
            "...GGPPGG...T....",
            "..G.PPWP.G..W....",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            ".............W....",
            ...companionHeadWide,
            "...GGPPGG..W.....",
            "..G.PPWP.G..T....",
            "....G..G.........",
            "...G....G........",
          ),
        ]),
      },
      "03": {
        name: "idea lantern",
        summary: "a brighter hanging idea-light pulses above the goblin",
        frames: normalizeFrames([
          createCompanionFrame(
            ".............W....",
            ...companionHeadWide,
            "...GGPPGG...W....",
            "..G.PPPP.G..W....",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            "............WT....",
            ...companionHeadWide,
            "...GGPPGG...T....",
            "..G.PPPP.G..W....",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            ".............T....",
            ...companionHeadWide,
            "...GGPPGG..WT....",
            "..G.PPPP.G..T....",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            "............TW....",
            ...companionHeadWide,
            "...GGPPGG...W....",
            "..G.PPPP.G..T....",
            "....G..G.........",
            "...G....G........",
          ),
        ]),
      },
    },
    image: {
      "01": {
        name: "brush dabs",
        summary: "a little cluster of paint dabs flickers beside the body",
        frames: normalizeFrames([
          createCompanionFrame(
            "..............W...",
            ...companionHeadWide,
            "...GGPPGG...WW....",
            "..G.PPPP.G..WT....",
            "....G..G....TW....",
            "...G....G.........",
          ),
          createCompanionFrame(
            ".............WT...",
            ...companionHeadWide,
            "...GGPPGG...WT....",
            "..G.PPPP.G..TT....",
            "....G..G....WW....",
            "...G....G.........",
          ),
          createCompanionFrame(
            "..............T...",
            ...companionHeadWide,
            "...GGPPGG..WTW....",
            "..G.PPPP.G..WW....",
            "....G..G....TT....",
            "...G....G.........",
          ),
          createCompanionFrame(
            ".............TW...",
            ...companionHeadWide,
            "...GGPPGG...WW....",
            "..G.PPPP.G..TW....",
            "....G..G....WT....",
            "...G....G.........",
          ),
        ]),
      },
      "02": {
        name: "pixel canvas",
        summary: "a tiny square canvas builds one block at a time to the right",
        frames: normalizeFrames([
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG....WW...",
            "..G.PPPP.G........",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...WWTT..",
            "..G.PPPP.G...WW...",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...WWTT..",
            "..G.PPPP.G...TTWW.",
            "....G..G....WWTT..",
            "...G....G........",
          ),
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...WTTW..",
            "..G.PPPP.G...TWWT.",
            "....G..G....WWTT..",
            "...G....G........",
          ),
        ]),
      },
      "03": {
        name: "frame sparkle",
        summary: "a little picture frame outline flashes with a bright center spark",
        frames: normalizeFrames([
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...W..W..",
            "..G.PPPP.G..W..W..",
            "....G..G....W..W..",
            "...G....G........",
          ),
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...WTTW..",
            "..G.PPPP.G..W..W..",
            "....G..G....WTTW..",
            "...G....G........",
          ),
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...WWWW..",
            "..G.PPPP.G..WTTW..",
            "....G..G....WWWW..",
            "...G....G........",
          ),
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...WTTW..",
            "..G.PPPP.G..W..W..",
            "....G..G....WTTW..",
            "...G....G........",
          ),
        ]),
      },
    },
    audio: {
      "01": {
        name: "pulse bars",
        summary: "stacked sound bars bounce beside the goblin",
        frames: normalizeFrames([
          createCompanionFrame(
            ".............T....",
            ...companionHeadWide,
            "...GGPPGG....W....",
            "..G.PPPP.G..WT....",
            "....G..G....W.....",
            "...G....G.........",
          ),
          createCompanionFrame(
            "............WTW...",
            ...companionHeadWide,
            "...GGPPGG...WT....",
            "..G.PPPP.G.WTW....",
            "....G..G....WT....",
            "...G....G.........",
          ),
          createCompanionFrame(
            "...........TWTW...",
            ...companionHeadWide,
            "...GGPPGG..TWT....",
            "..G.PPPP.G.WTW....",
            "....G..G...TWT....",
            "...G....G.........",
          ),
          createCompanionFrame(
            "............WTW...",
            ...companionHeadWide,
            "...GGPPGG...WT....",
            "..G.PPPP.G..WT....",
            "....G..G....W.....",
            "...G....G.........",
          ),
        ]),
      },
      "02": {
        name: "echo rings",
        summary: "sound ripples flare above the goblin in widening rings",
        frames: normalizeFrames([
          createCompanionFrame(
            ".............W....",
            ...companionHeadWide,
            "...GGPPGG........",
            "..G.PPPP.G.......",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            "............WTW...",
            ...companionHeadWide,
            "...GGPPGG....W....",
            "..G.PPPP.G.......",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            "...........WTTTW..",
            ...companionHeadWide,
            "...GGPPGG...WT....",
            "..G.PPPP.G.......",
            "....G..G.........",
            "...G....G........",
          ),
          createCompanionFrame(
            "............WTW...",
            ...companionHeadWide,
            "...GGPPGG....W....",
            "..G.PPPP.G.......",
            "....G..G.........",
            "...G....G........",
          ),
        ]),
      },
      "03": {
        name: "mixer sliders",
        summary: "small control sliders hop between levels to the right",
        frames: normalizeFrames([
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...W.T...",
            "..G.PPPP.G..W.T...",
            "....G..G....W.....",
            "...G....G.........",
          ),
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...WT....",
            "..G.PPPP.G..WTT...",
            "....G..G....W.....",
            "...G....G.........",
          ),
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG....T.W..",
            "..G.PPPP.G..TT.W..",
            "....G..G.....W....",
            "...G....G.........",
          ),
          createCompanionFrame(
            ...companionHeadWide,
            "...GGPPGG...WT....",
            "..G.PPPP.G..W.T...",
            "....G..G....W.....",
            "...G....G.........",
          ),
        ]),
      },
    },
  } as const
  const companionActivityDefaultVariants = {
    thinking: "01",
    image: "01",
    audio: "01",
  } as const
  type CompanionActivityKey = keyof typeof companionActivityVariantCatalog
  type CompanionActivityVariantKey = "01" | "02" | "03"

  const requestedVariantId = normalizeChatGoblinVariantId(process.env.CODEGOBLIN_CHAT_GOBLIN_VARIANT)
  const actionVariantId = codeGoblinCompanionActionVariant(process.env.CODEGOBLIN_COMPANION_ACTION_VARIANT)
  const activityVariantId = codeGoblinCompanionActivityVariant(process.env.CODEGOBLIN_COMPANION_ACTIVITY_VARIANT)
  const motionMode = codeGoblinCompanionMode(process.env.CODEGOBLIN_CHAT_GOBLIN_MODE)
  const requestedFrameIndex = normalizeChatGoblinFrame(process.env.CODEGOBLIN_CHAT_GOBLIN_FRAME)
  const companionPreviewEnabled =
    motionMode === "companion" && codeGoblinFlagEnabled(process.env.CODEGOBLIN_COMPANION_PREVIEW)
  const previewActionEnabled = companionPreviewEnabled && process.env.CODEGOBLIN_COMPANION_ACTION_VARIANT !== undefined
  const previewActivityKind = codeGoblinCompanionActivity(process.env.CODEGOBLIN_COMPANION_ACTIVITY)
  const currentActivityKind = createMemo(() => {
    if (companionPreviewEnabled && previewActivityKind !== "idle") return previewActivityKind
    return props.activityKind
  })
  const actionAge = createMemo(() => {
    const start = actionStartTick()
    if (start === undefined) return Number.POSITIVE_INFINITY
    return tick() - start
  })
  const previewActionAge = createMemo(() => {
    if (!previewActionEnabled) return Number.POSITIVE_INFINITY
    const phase = tick() % 24
    if (phase < 8 || phase >= 22) return Number.POSITIVE_INFINITY
    return phase - 8
  })
  const effectiveActionAge = createMemo(() => {
    const actualAge = actionAge()
    if (actualAge >= 0 && actualAge < 14) return actualAge
    return previewActionAge()
  })
  const actionActive = createMemo(() => effectiveActionAge() >= 0 && effectiveActionAge() < 14)
  const selectedVariant = createMemo(
    () =>
      chatGoblinVariants.find((variant) => variant.id === requestedVariantId) ??
      chatGoblinVariants.find((variant) => variant.id === "40") ??
      chatGoblinVariants[0],
  )
  const frames = createMemo<string[][]>(() => {
    if (motionMode === "companion") {
      if (actionActive()) {
        return companionActionFrames[actionVariantId as keyof typeof companionActionFrames] ?? companionIdleFrames
      }
      const kind = currentActivityKind()
      if (kind !== "idle") {
        const variants = companionActivityVariantCatalog[kind satisfies CompanionActivityKey]
        const variantId: CompanionActivityVariantKey =
          companionPreviewEnabled && previewActivityKind !== "idle"
            ? activityVariantId
            : companionActivityDefaultVariants[kind]
        return variants[variantId].frames ?? companionIdleFrames
      }
      return companionIdleFrames
    }
    return normalizeFrames(selectedVariant().frames)
  })
  const width = createMemo(() => Math.max(...frames().flatMap((frame) => frame.map((row) => row.length))))
  const sessionSpendText = createMemo(() => money.format(Math.max(0, props.sessionCost)))
  const lastBurnText = createMemo(() => {
    const burn = lastBurn()
    if (!burn) return undefined
    if (burn.kind === "spend") return money.format(Math.max(0, burn.amount))
    return `${number.format(Math.max(0, burn.amount))} tokens`
  })
  const previewBurnAmount = createMemo(() => {
    if (!previewActionEnabled) return undefined
    if (actionVariantId === "02") return 0.25
    if (actionVariantId === "03") return 0.39
    if (actionVariantId === "04") return Math.max(1.04, props.sessionCost)
    return 0.14
  })
  const effectiveBurn = createMemo(() => {
    const burn = lastBurn()
    if (burn) return burn
    if (actionActive()) {
      const previewAmount = previewBurnAmount()
      if (previewAmount === undefined) return undefined
      return {
        kind: "spend",
        amount: previewAmount,
      } as const
    }
    return undefined
  })
  const effectiveBurnText = createMemo(() => {
    const burn = effectiveBurn()
    if (!burn) return undefined
    if (burn.kind === "spend") return money.format(Math.max(0, burn.amount))
    return `${number.format(Math.max(0, burn.amount))} tokens`
  })
  const previewActivityText = createMemo(() => {
    if (currentActivityKind() === "thinking") return "sorting thoughts into a reply"
    if (currentActivityKind() === "image") return "painting pixels into place"
    if (currentActivityKind() === "audio") return "mixing waveforms into audio"
    return "by the hoard, ready to dig"
  })
  const companionHeadline = createMemo(() => {
    if (actionActive()) return effectiveBurn()?.kind === "tokens" ? "Grik burns tokens" : "Grik adds spend"
    if (currentActivityKind() === "thinking") return "Grik is thinking"
    if (currentActivityKind() === "image") return "Grik paints pixels"
    if (currentActivityKind() === "audio") return "Grik mixes audio"
    if (props.active) return "Grik is digging"
    return "Grik · your goblin"
  })
  const actionText = createMemo(() => {
    if (!actionActive()) {
      if (currentActivityKind() !== "idle") {
        if (companionPreviewEnabled && previewActivityKind !== "idle") return previewActivityText()
        return props.activityText
      }
      return props.active ? props.activityText : "by the hoard, ready to dig"
    }
    const burn = effectiveBurn()
    const delta = `+${effectiveBurnText() ?? lastBurnText() ?? "$0.00"}`
    if (burn?.kind === "tokens") return `tosses ${delta} into the token burn pile`
    if (actionVariantId === "02") return `stamps ${delta} onto the spend slip`
    if (actionVariantId === "03") return `tosses ${delta} into the spend pile`
    if (actionVariantId === "04") return `replaces the total with ${sessionSpendText()}`
    return `pulls ${delta} from his pocket`
  })

  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    timer = setInterval(() => setTick((value) => value + 1), 200)
    timer?.unref?.()
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  createEffect(() => {
    const current = Math.max(0, props.sessionCost)
    const currentTokens = Math.max(0, props.sessionTokens)
    if (previousSessionCost === undefined || previousSessionTokens === undefined) {
      previousSessionCost = current
      previousSessionTokens = currentTokens
      return
    }
    const burn = codeGoblinCompanionBurnDelta({
      previousCost: previousSessionCost,
      currentCost: current,
      previousTokens: previousSessionTokens,
      currentTokens,
    })
    previousSessionCost = current
    previousSessionTokens = currentTokens
    if (!burn) return
    setLastBurn(burn)
    setActionStartTick(tick())
  })

  function renderRow(rowIndex: number) {
    const currentFrames = frames()
    const currentWidth = width()
    const animatedFrame = currentFrames[tick() % currentFrames.length] ?? currentFrames[0] ?? []
    const fixedFrame = requestedFrameIndex !== undefined ? currentFrames[requestedFrameIndex] : undefined
    const frame = fixedFrame ?? animatedFrame
    const spriteRow = frame[rowIndex] ?? "".padEnd(currentWidth, ".")
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
        cells.push(<text fg={spendColor}>██</text>)
      } else {
        cells.push(<text>  </text>)
      }
    }

    return cells
  }

  return (
    <box flexDirection="column" alignItems="center" paddingTop={1} paddingBottom={1} width="100%">
      <box flexDirection="column" gap={0} width="100%" paddingBottom={1}>
        <text fg={actionActive() ? spendColor : props.theme.text}>
          <b>{companionHeadline()}</b>
        </text>
        <box flexDirection="row" gap={1}>
          <text fg={props.theme.textMuted}>spend :</text>
          <text fg={spendColor}>{sessionSpendText()}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={props.theme.textMuted}>last  :</text>
          <text fg={effectiveBurn() !== undefined ? spendColor : props.theme.textMuted}>
            {effectiveBurnText() ? `+${effectiveBurnText()}` : "waiting"}
          </text>
        </box>
        <text fg={actionActive() ? spendColor : props.active ? props.theme.text : props.theme.textMuted} wrapMode="none">
          {actionText()}
        </text>
        <text fg={props.theme.textMuted} wrapMode="none">
          {props.contextText}
        </text>
      </box>
      {Array.from({ length: frames()[0]?.length ?? 0 }, (_, rowIndex) => (
        <box flexDirection="row" width={width() * 2}>
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
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const pending = createMemo(() => messages().findLast((item) => item.role === "assistant" && !item.time.completed)?.id)
  const showChatGoblin = createMemo(() => codeGoblinCompanionVisible(process.env.CODEGOBLIN_CHAT_GOBLIN))
  const latestCodeGoblinAssetState = createMemo(() => {
    let latest: string | undefined
    for (const message of messages()) {
      for (const part of sync.data.part[message.id] ?? []) {
        const metadata = (part as { metadata?: Record<string, unknown> }).metadata
        const raw = metadata?.codegoblin
        if (!raw || typeof raw !== "object") continue
        const kind = (raw as Record<string, unknown>).kind
        if (typeof kind === "string") latest = kind
      }
    }
    return latest
  })
  const companionUsage = createMemo(() => {
    const number = new Intl.NumberFormat("en-US")
    const assetState = latestCodeGoblinAssetState()
    const activityKind = (() => {
      if (assetState?.includes("image-progress")) return "image" as const
      if (assetState?.includes("audio-progress")) return "audio" as const
      if (pending()) return "thinking" as const
      return "idle" as const
    })()
    const assistantMessages = messages().filter((item): item is AssistantMessage => item.role === "assistant")
    const sessionTokens = assistantMessages.reduce(
      (total, item) =>
        total + item.tokens.input + item.tokens.output + item.tokens.reasoning + item.tokens.cache.read + item.tokens.cache.write,
      0,
    )
    // Spend must include image/audio generation, whose cost lives on synthetic assistant
    // messages and is not always folded back into session.cost.
    const cost = Math.max(
      session()?.cost ?? 0,
      assistantMessages.reduce((total, item) => total + Math.max(0, item.cost ?? 0), 0),
    )
    const last = assistantMessages.findLast((item) => item.tokens.output > 0)
    const activityText = (() => {
      if (assetState?.includes("image-progress")) return "painting an image"
      if (assetState?.includes("audio-progress")) return "mixing audio"
      if (pending()) return "thinking through the reply"
      if (assetState?.includes("image-result")) return "image ready"
      if (assetState?.includes("audio-result")) return "audio ready"
      return "ready for the next prompt"
    })()
    if (!last) {
      return {
        contextText: pending() ? "tokens warming up" : "no token spend yet",
        sessionCost: cost,
        sessionTokens,
        activityText,
        activityKind,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const ratio = model?.limit.context ? Math.max(0, Math.min(1, tokens / model.limit.context)) : undefined

    return {
      contextText:
        ratio !== undefined
          ? `${number.format(tokens)} tokens · ${Math.round(ratio * 100)}% ctx`
          : `${number.format(tokens)} tokens tracked`,
      sessionCost: cost,
      sessionTokens,
      activityText,
      activityKind,
    }
  })
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
            <TuiSidebarCompanionGoblin
              theme={theme}
              active={Boolean(pending()) || companionUsage().activityKind !== "idle"}
              contextText={companionUsage().contextText}
              sessionCost={companionUsage().sessionCost}
              sessionTokens={companionUsage().sessionTokens}
              activityText={companionUsage().activityText}
              activityKind={companionUsage().activityKind}
            />
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
