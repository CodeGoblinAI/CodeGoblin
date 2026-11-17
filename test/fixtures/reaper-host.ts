// Stands in for the app in test/reaper.test.ts: starts a background job, a command it waits for, and a
// command that starts something and lets it go; prints its own number; then waits to be killed outright.
import { runForeground, startJob } from "../../src/core/jobs"

const mark = process.argv[2]!
const keepAlive = `node -e "setInterval(()=>{},1000)"`
await startJob(`${keepAlive} ${mark}-job`, process.cwd(), { firstLookMs: 200 })
void runForeground(`${keepAlive} ${mark}-waited`, process.cwd(), { timeoutMs: 600_000 })
// Started and let go: the command ends at once, and what it started is no longer any command's.
const letGo = process.platform === "win32" ? `start "" /b ${keepAlive} ${mark}-letgo` : `(${keepAlive} ${mark}-letgo &)`
await runForeground(letGo, process.cwd(), { timeoutMs: 10_000 })
console.log("ready " + process.pid)
setInterval(() => {}, 1000)
