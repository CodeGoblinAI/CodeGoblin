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
      arg !== "runner" &&
      arg !== "chat-goblin" &&
      arg !== "chat-bottom-goblin" &&
      arg !== "--runner-variant" &&
      arg !== "--chat-goblin" &&
      arg !== "--chat-goblin-variant" &&
      arg !== "--chat-bottom-goblin" &&
      args[index - 1] !== "--runner-variant" &&
      args[index - 1] !== "--chat-goblin" &&
      args[index - 1] !== "--chat-goblin-variant" &&
      args[index - 1] !== "--chat-bottom-goblin" &&
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
  args.includes("--chat-goblin-variant") ||
  Boolean(getOptionValue("--chat-goblin")) ||
  Boolean(getOptionValue("--chat-goblin-variant"))
const showChatBottomGoblin = args.includes("--chat-bottom-goblin") || args.includes("chat-bottom-goblin")
const rawChatGoblinVariant = getOptionValue("--chat-goblin") ?? getOptionValue("--chat-goblin-variant") ?? "04"
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

const variant = String(numeric).padStart(2, "0")
const runnerVariant = String(runnerNumeric).padStart(2, "0")
const chatGoblinVariant = String(chatGoblinNumeric).padStart(2, "0")
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

console.log(`Starting CodeGoblin TUI header variant ${variant}...`)
if (showRunner) {
  console.log(`Footer goblin runner ${runnerVariant} enabled (${runnerVariantNames[runnerVariant as keyof typeof runnerVariantNames]}).`)
}
if (showChatGoblin) {
  console.log(
    `Chat sidebar goblin ${chatGoblinVariant} enabled (${chatGoblinVariantNames[chatGoblinVariant as keyof typeof chatGoblinVariantNames]}).`,
  )
}
if (showChatBottomGoblin) {
  console.log("Chat bottom goblin enabled.")
}
console.log("Press Ctrl+C to stop this variant before trying another one.\n")

const child = Bun.spawn([process.execPath, "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEGOBLIN_HEADER_VARIANT: variant,
    ...(showRunner ? { CODEGOBLIN_FOOTER_ANIMATION: "1", CODEGOBLIN_FOOTER_VARIANT: runnerVariant } : {}),
    ...(showChatGoblin ? { CODEGOBLIN_CHAT_GOBLIN: "1", CODEGOBLIN_CHAT_GOBLIN_VARIANT: chatGoblinVariant } : {}),
    ...(showChatBottomGoblin ? { CODEGOBLIN_CHAT_BOTTOM_GOBLIN: "1" } : {}),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await child.exited)
