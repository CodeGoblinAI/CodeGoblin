import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const args = Bun.argv.slice(2)

function getOptionValue(flag: string) {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)

  const index = args.indexOf(flag)
  if (index === -1) return undefined

  const next = args[index + 1]
  if (!next || next.startsWith("--")) return undefined
  return next
}

const rawVariant =
  args.find(
    (arg, index) =>
      arg !== "list" &&
      arg !== "list-runner" &&
      arg !== "list-chat-goblin" &&
      arg !== "list-companion" &&
      arg !== "runner" &&
      arg !== "chat-goblin" &&
      arg !== "companion" &&
      arg !== "--runner-variant" &&
      arg !== "--chat-goblin" &&
      arg !== "--chat-goblin-variant" &&
        arg !== "--chat-goblin-frame" &&
      arg !== "--companion-activity" &&
      arg !== "--companion-activity-variant" &&
      arg !== "--companion-action" &&
      args[index - 1] !== "--runner-variant" &&
      args[index - 1] !== "--chat-goblin" &&
      args[index - 1] !== "--chat-goblin-variant" &&
        args[index - 1] !== "--chat-goblin-frame" &&
      args[index - 1] !== "--companion-activity" &&
      args[index - 1] !== "--companion-activity-variant" &&
      args[index - 1] !== "--companion-action" &&
      !arg.startsWith("--"),
  ) ?? "01"
const showRunner =
  args.includes("--runner") ||
  args.includes("runner") ||
  args.includes("--runner-variant") ||
  Boolean(getOptionValue("--runner")) ||
  Boolean(getOptionValue("--runner-variant"))
const rawRunnerVariant = getOptionValue("--runner") ?? getOptionValue("--runner-variant") ?? "12"
const showChatGoblin =
  args.includes("--chat-goblin") ||
  args.includes("chat-goblin") ||
  args.includes("companion") ||
  args.includes("--chat-goblin-variant") ||
  args.includes("--chat-goblin-frame") ||
  args.includes("--companion-activity") ||
  args.includes("--companion-activity-variant") ||
  args.includes("--companion-action") ||
  Boolean(getOptionValue("--chat-goblin")) ||
  Boolean(getOptionValue("--chat-goblin-variant")) ||
  Boolean(getOptionValue("--chat-goblin-frame")) ||
  Boolean(getOptionValue("--companion-activity")) ||
  Boolean(getOptionValue("--companion-activity-variant")) ||
  Boolean(getOptionValue("--companion-action"))
const rawChatGoblinVariant = getOptionValue("--chat-goblin") ?? getOptionValue("--chat-goblin-variant") ?? "40"
const rawChatGoblinFrame = getOptionValue("--chat-goblin-frame")
const rawCompanionActivity = getOptionValue("--companion-activity")
const rawCompanionActivityVariant = getOptionValue("--companion-activity-variant")
const showCompanionMode =
  args.includes("companion") ||
  args.includes("--companion-action") ||
  args.includes("--companion-activity") ||
  Boolean(getOptionValue("--companion-action")) ||
  Boolean(rawCompanionActivity)
const rawCompanionActionVariant =
  getOptionValue("--companion-action") ?? (showCompanionMode && !rawCompanionActivity ? "01" : undefined)
const runnerVariantNames = {
  "01": "tiny classic",
  "02": "micro scout",
  "03": "round bobber",
  "04": "hooded runner",
  "05": "big ear scout",
  "06": "sneaksnout",
  "07": "rogue dagger",
  "08": "scar hood",
  "09": "squat bruiser",
  "10": "deluxe goblin",
  "11": "lean sneak",
  "12": "pickpocket",
  "13": "mini nib",
  "14": "crouch hop",
  "15": "hunched runner",
  "16": "satchel scout",
  "17": "hood pip",
  "18": "low bruiser",
  "19": "crooknose",
  "20": "compact deluxe",
} as const
const runnerVariantCount = Object.keys(runnerVariantNames).length
const chatGoblinVariantNames = {
  "01": "gate snap",
  "02": "long-ear gulp",
  "03": "hood maw",
  "04": "token chomper",
  "05": "cave grinner",
  "06": "bat-ear chew",
  "07": "crown crunch",
  "08": "heavy jaw",
  "09": "sly nib",
  "10": "deluxe maw",
  "11": "knife grin",
  "12": "lantern bite",
  "13": "hood profile",
  "14": "wide tooth",
  "15": "coin inhale",
  "16": "imp yawn",
  "17": "skullcap chew",
  "18": "snout snap",
  "19": "needle teeth",
  "20": "clean mascot",
  "21": "menu tiny body",
  "22": "menu thin scout",
  "23": "menu chunky hoodie",
  "24": "menu tall lanky",
  "25": "menu squat bruiser",
  "26": "menu little thief",
  "27": "menu cloak triangle",
  "28": "menu big boots",
  "29": "menu needle thin",
  "30": "menu wide arms",
  "31": "profile bite body",
  "32": "profile skinny run",
  "33": "profile heavy pack",
  "34": "menu satchel side",
  "35": "menu tiny imp",
  "36": "menu tall robe",
  "37": "menu thick shell",
  "38": "menu spare mascot",
  "39": "menu token lunge",
  "40": "menu clean body",
} as const
const chatGoblinVariantCount = Object.keys(chatGoblinVariantNames).length
const companionActionVariantNames = {
  "01": "pocket add",
  "02": "stamp spend",
  "03": "coin toss",
  "04": "total replace",
} as const
const companionActivityNames = {
  thinking: "ponder reply",
  image: "paint image",
  audio: "mix audio",
} as const
const companionActivityVariantNames = {
  thinking: {
    "01": "thought pips",
    "02": "chin spark",
    "03": "idea lantern",
  },
  image: {
    "01": "brush dabs",
    "02": "pixel canvas",
    "03": "frame sparkle",
  },
  audio: {
    "01": "pulse bars",
    "02": "echo rings",
    "03": "mixer sliders",
  },
} as const
const companionActionVariantCount = Object.keys(companionActionVariantNames).length

if (args.includes("--list") || args.includes("list")) {
  for (let i = 1; i <= 47; i++) {
    const variant = String(i).padStart(2, "0")
    console.log(`bun run dev:header:${variant}`)
  }
  process.exit(0)
}

if (args.includes("--list-runner") || args.includes("list-runner")) {
  for (let i = 1; i <= runnerVariantCount; i++) {
    const runnerVariant = String(i).padStart(2, "0") as keyof typeof runnerVariantNames
    console.log(`bun run dev:runner:${runnerVariant}  # ${runnerVariantNames[runnerVariant]}`)
  }
  process.exit(0)
}

if (args.includes("--list-chat-goblin") || args.includes("list-chat-goblin")) {
  for (let i = 1; i <= chatGoblinVariantCount; i++) {
    const chatGoblinVariant = String(i).padStart(2, "0") as keyof typeof chatGoblinVariantNames
    console.log(`bun run dev:chat:goblin:${chatGoblinVariant}  # ${chatGoblinVariantNames[chatGoblinVariant]}`)
  }
  process.exit(0)
}

if (args.includes("--list-companion") || args.includes("list-companion")) {
  console.log("# spend actions")
  for (let i = 1; i <= companionActionVariantCount; i++) {
    const companionVariant = String(i).padStart(2, "0") as keyof typeof companionActionVariantNames
    console.log(`bun run dev:companion:${companionVariant}  # ${companionActionVariantNames[companionVariant]}`)
  }
  console.log("\n# activity previews")
  for (const [activity, label] of Object.entries(companionActivityNames)) {
    console.log(`bun run dev:companion:${activity}  # ${label}`)
    for (const [variantId, variantLabel] of Object.entries(companionActivityVariantNames[activity as keyof typeof companionActivityVariantNames])) {
      console.log(`bun run dev:companion:${activity}:${variantId}  # ${variantLabel}`)
    }
  }
  process.exit(0)
}

const numeric = Number(rawVariant.trim().replace(/^v/i, ""))

if (!Number.isInteger(numeric) || numeric < 1 || numeric > 47) {
  console.error(`Expected a header variant from 1 to 47, got: ${rawVariant}`)
  process.exit(1)
}

const runnerNumeric = Number(rawRunnerVariant.trim().replace(/^v/i, ""))

if (showRunner && (!Number.isInteger(runnerNumeric) || runnerNumeric < 1 || runnerNumeric > runnerVariantCount)) {
  console.error(`Expected a footer runner variant from 1 to ${runnerVariantCount}, got: ${rawRunnerVariant}`)
  process.exit(1)
}

const chatGoblinNumeric = Number(rawChatGoblinVariant.trim().replace(/^v/i, ""))

if (
  showChatGoblin &&
  (!Number.isInteger(chatGoblinNumeric) || chatGoblinNumeric < 1 || chatGoblinNumeric > chatGoblinVariantCount)
) {
  console.error(`Expected a chat goblin variant from 1 to ${chatGoblinVariantCount}, got: ${rawChatGoblinVariant}`)
  process.exit(1)
}

const chatGoblinFrameNumeric = rawChatGoblinFrame === undefined ? undefined : Number(rawChatGoblinFrame.trim())

if (
  showChatGoblin &&
  chatGoblinFrameNumeric !== undefined &&
  (!Number.isInteger(chatGoblinFrameNumeric) || chatGoblinFrameNumeric < 1 || chatGoblinFrameNumeric > 4)
) {
  console.error(`Expected a chat goblin frame from 1 to 4, got: ${rawChatGoblinFrame}`)
  process.exit(1)
}

const companionActionNumeric = rawCompanionActionVariant
  ? Number(rawCompanionActionVariant.trim().replace(/^v/i, ""))
  : undefined
const companionActivity = rawCompanionActivity?.trim().toLowerCase() as keyof typeof companionActivityNames | undefined
const companionActivityVariantNumeric = rawCompanionActivityVariant
  ? Number(rawCompanionActivityVariant.trim().replace(/^v/i, ""))
  : undefined

if (
  showCompanionMode &&
  rawCompanionActionVariant !== undefined &&
  (!Number.isInteger(companionActionNumeric) ||
    companionActionNumeric < 1 ||
    companionActionNumeric > companionActionVariantCount)
) {
  console.error(`Expected a companion action variant from 1 to ${companionActionVariantCount}, got: ${rawCompanionActionVariant}`)
  process.exit(1)
}

if (companionActivity && !(companionActivity in companionActivityNames)) {
  console.error(
    `Expected a companion activity preview of ${Object.keys(companionActivityNames).join(", ")}, got: ${rawCompanionActivity}`,
  )
  process.exit(1)
}

if (
  companionActivity &&
  rawCompanionActivityVariant !== undefined &&
  (!Number.isInteger(companionActivityVariantNumeric) || companionActivityVariantNumeric < 1 || companionActivityVariantNumeric > 3)
) {
  console.error(`Expected a companion activity variant from 1 to 3, got: ${rawCompanionActivityVariant}`)
  process.exit(1)
}

const variant = String(numeric).padStart(2, "0")
const runnerVariant = String(runnerNumeric).padStart(2, "0")
const chatGoblinVariant = String(chatGoblinNumeric).padStart(2, "0")
const companionActionVariant = companionActionNumeric ? String(companionActionNumeric).padStart(2, "0") : undefined
const companionActivityVariant = companionActivity
  ? String(companionActivityVariantNumeric ?? 1).padStart(2, "0")
  : undefined
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

console.log(`Starting CodeGoblin TUI header variant ${variant}...`)
if (showRunner) {
  console.log(`Footer goblin runner ${runnerVariant} enabled (${runnerVariantNames[runnerVariant as keyof typeof runnerVariantNames]}).`)
}
if (showChatGoblin) {
  if (showCompanionMode && companionActionVariant) {
    console.log(
      `Companion base sprite ${chatGoblinVariant} enabled (${chatGoblinVariantNames[chatGoblinVariant as keyof typeof chatGoblinVariantNames]}).`,
    )
    console.log(
      `Companion action ${companionActionVariant} enabled (${companionActionVariantNames[companionActionVariant as keyof typeof companionActionVariantNames]}; dedicated companion animation).`,
    )
    if (chatGoblinFrameNumeric !== undefined) {
      console.log(`Companion frame ${chatGoblinFrameNumeric} locked for comparison.`)
    }
  } else if (showCompanionMode && companionActivity) {
    console.log(
      `Companion base sprite ${chatGoblinVariant} enabled (${chatGoblinVariantNames[chatGoblinVariant as keyof typeof chatGoblinVariantNames]}).`,
    )
    console.log(
      `Companion activity preview enabled (${companionActivityNames[companionActivity]}; variant ${companionActivityVariant} ${companionActivityVariantNames[companionActivity][companionActivityVariant as keyof (typeof companionActivityVariantNames)[typeof companionActivity]]}).`,
    )
    if (chatGoblinFrameNumeric !== undefined) {
      console.log(`Companion frame ${chatGoblinFrameNumeric} locked for comparison.`)
    }
  } else {
    console.log(
      `Chat sidebar goblin ${chatGoblinVariant} enabled (${chatGoblinVariantNames[chatGoblinVariant as keyof typeof chatGoblinVariantNames]}).`,
    )
    if (chatGoblinFrameNumeric !== undefined) {
      console.log(`Chat sidebar goblin frame ${chatGoblinFrameNumeric} locked for comparison.`)
    }
  }
}
console.log("Press Ctrl+C to stop this variant before trying another one.\n")

const child = Bun.spawn([process.execPath, "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEGOBLIN_HEADER_VARIANT: variant,
    ...(showRunner ? { CODEGOBLIN_FOOTER_ANIMATION: "1", CODEGOBLIN_FOOTER_VARIANT: runnerVariant } : {}),
    ...(showChatGoblin
      ? {
          CODEGOBLIN_CHAT_GOBLIN: "1",
          CODEGOBLIN_CHAT_GOBLIN_MODE: showCompanionMode ? "companion" : "pinned",
          CODEGOBLIN_CHAT_GOBLIN_VARIANT: chatGoblinVariant,
          ...(chatGoblinFrameNumeric !== undefined ? { CODEGOBLIN_CHAT_GOBLIN_FRAME: String(chatGoblinFrameNumeric) } : {}),
          ...(showCompanionMode && (companionActionVariant || companionActivity)
            ? {
                ...(companionActionVariant ? { CODEGOBLIN_COMPANION_ACTION_VARIANT: companionActionVariant } : {}),
                ...(companionActivity ? { CODEGOBLIN_COMPANION_ACTIVITY: companionActivity } : {}),
                ...(companionActivityVariant ? { CODEGOBLIN_COMPANION_ACTIVITY_VARIANT: companionActivityVariant } : {}),
                CODEGOBLIN_COMPANION_PREVIEW: "1",
              }
            : {}),
        }
      : {}),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await child.exited)
