import {expect,test} from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import {parseClaudeAccount,claudeUsage,subscriptionAccount,cachedSubscriptionAccount,subscriptionRows} from "../src/core/subscription-account"
import {Global} from "../src/platform/paths"
import {requireSandbox} from "./sandbox"
import {runCommand} from "../src/core/commands"
requireSandbox(Global.Path.state,"subscription accounts")
const command=(mode="ok")=>[process.execPath,path.join(import.meta.dir,"fixtures/claude-account.ts"),mode]
test("Claude uses reported windows; missing/invalid is not zero",()=>{
  const parsed=parseClaudeAccount({rate_limits_available:true,rate_limits:{five_hour:{utilization:140,resets_at:"2026-10-05T00:00:00Z"},seven_day:{utilization:null,resets_at:"bad"}}})
  expect(parsed.windows[0]?.used).toBe(140)
  expect(subscriptionRows(parsed).some(x=>x[1].includes("0% remaining"))).toBe(true)
  expect(parsed.windows[1]?.used).toBeUndefined()
  expect(parsed.windows[1]?.resetsAt).toBeUndefined()
  expect(parseClaudeAccount({rate_limits_available:false}).state).toBe("unavailable")
})
test("read-only control requests return quota and persist only display fields",async()=>{
  const snapshot=await subscriptionAccount("claude",command())
  expect(snapshot.state).toBe("ready")
  expect(snapshot.windows[0]?.used).toBe(25)
  expect((await cachedSubscriptionAccount("claude"))?.windows[1]?.used).toBe(0)
  expect(await fs.readFile(path.join(Global.Path.state,"claude-account.json"),"utf8")).not.toContain("NEVER_CACHE")
})
test("native actions, unsupported control and timeout fail safely",async()=>{
  await expect(claudeUsage(command("native"))).rejects.toThrow("native")
  await expect(claudeUsage(command("unsupported"))).rejects.toThrow("unsupported")
  await expect(claudeUsage(command("hang"),100)).rejects.toThrow()
  expect(JSON.stringify(await subscriptionAccount("claude",command("unsupported")))).not.toContain("SECRET_ERROR")
})
test("Cursor unsupported personal quota is explicit, not a zero balance",async()=>{
  const snapshot=await subscriptionAccount("cursor")
  expect(snapshot.state).toBe("unavailable")
  expect(snapshot.windows).toEqual([])
  expect(snapshot.detail).toContain("not subscription allowance")
  expect(runCommand("/account claude-code")).toEqual({kind:"account",source:"claude"})
  expect(runCommand("/account cursor")).toEqual({kind:"account",source:"cursor"})
})
