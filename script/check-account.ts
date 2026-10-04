import { codexAccount, accountRows } from "../src/core/codex-account"
const snapshot = await codexAccount()
for (const [label, value] of accountRows(snapshot)) console.log(label + ": " + value)
if (snapshot.state !== "ready") process.exitCode = 1
