/**
 * The plan a turn is working through.
 *
 * Multi-step work is otherwise invisible until it finishes: the model says
 * nothing for a minute, then produces everything at once. A visible list also
 * keeps the model honest, because it has to say what it intends before doing
 * it and mark items off as it goes.
 *
 * State lives per session and is replaced wholesale on each write, which is
 * simpler than diffing and matches how models actually use it - they resend
 * the full list with updated statuses.
 */
export type TodoStatus = "pending" | "in_progress" | "completed"

export type Todo = {
  content: string
  status: TodoStatus
}

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"]

export function parseTodos(input: unknown): Todo[] {
  if (!Array.isArray(input)) return []
  return input
    .map((item) => {
      const record = item as Record<string, unknown>
      const content = typeof record?.content === "string" ? record.content.trim() : ""
      const status = STATUSES.includes(record?.status as TodoStatus)
        ? (record.status as TodoStatus)
        : "pending"
      return { content, status }
    })
    .filter((todo) => todo.content.length > 0)
    .slice(0, 30)
}

export function summarise(todos: Todo[]): string {
  if (!todos.length) return "plan cleared"
  const done = todos.filter((todo) => todo.status === "completed").length
  const active = todos.find((todo) => todo.status === "in_progress")
  const progress = `${done}/${todos.length}`
  return active ? `${progress}  ${active.content}` : progress
}

/** Marker used in both surfaces so the plan reads the same way. */
export function marker(status: TodoStatus): string {
  if (status === "completed") return "x"
  if (status === "in_progress") return ">"
  return " "
}

export function counts(todos: Todo[]) {
  return {
    total: todos.length,
    done: todos.filter((t) => t.status === "completed").length,
    active: todos.filter((t) => t.status === "in_progress").length,
  }
}
