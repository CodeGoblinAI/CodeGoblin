import { askedFor } from "./permission"
import { parseTodos, type Todo } from "./todo"
import type { AgentEvent } from "./agent"
import type { SubagentEvent } from "./subagents"

type ActivityItem = { id: string; name: string; label: string; state: "running" | "done" | "failed" | "interrupted" }
export type SessionActivity = { items: ActivityItem[]; plan: Todo[] }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)

export function normaliseActivity(raw: unknown, finished = false): SessionActivity {
  const value = record(raw) ? raw : {}
  const items = (Array.isArray(value.items) ? value.items : []).filter(record).slice(-100).flatMap(item => {
    if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.label !== "string" || !["running", "done", "failed", "interrupted"].includes(String(item.state))) return []
    return [{ id: item.id.slice(0, 128), name: item.name.slice(0, 128), label: item.label.slice(0, 300), state: finished && item.state === "running" ? "interrupted" as const : item.state as ActivityItem["state"] }]
  })
  return { items, plan: parseTodos(value.plan).map(todo => ({ ...todo, content: todo.content.slice(0, 2000) })) }
}

/** Display-only event metadata; it never enters inference or executes tools. */
export function recordActivity(activity: SessionActivity, source: AgentEvent | SubagentEvent) {
  const event = source.type === "subagent_event" ? source.event : source
  const prefix = source.type === "subagent_event" ? source.task + ":" : ""
  if (event.type === "plan" && !prefix) activity.plan = parseTodos(event.todos).map(todo => ({ ...todo, content: todo.content.slice(0, 2000) }))
  if (event.type !== "tool_start" && event.type !== "tool_end" && event.type !== "tool_denied") return
  const id = prefix + event.id
  if (event.type === "tool_start") {
    activity.items.push({ id: id.slice(0, 128), name: event.name.slice(0, 128), label: ((prefix ? "subagent · " : "") + event.name + " · " + askedFor(event.name, event.args)).slice(0, 300), state: "running" })
    activity.items = activity.items.slice(-100)
    return
  }
  const item = [...activity.items].reverse().find(item => item.id === id)
  if (!item) return
  if (event.type === "tool_denied") { item.state = "failed"; return }
  if (item.state !== "failed") item.state = /^(error|stopped|refused)/i.test(event.result) ? "failed" : "done"
}
