/**
 * The model asking the person something, part way through a task.
 *
 * The fork has this as its question tool. Without one, a model that needs a
 * decision either guesses or ends its turn with a question and loses its
 * place; with it, it can offer the choices it sees and carry on with the
 * answer. Offered only where someone can answer - the terminal and the
 * browser - never to a subagent or a one-shot run.
 */
export type QuestionOption = { label: string; description?: string }
export type Question = { question: string; options: QuestionOption[]; multiple: boolean }
/** The person's answer: the labels picked, or their own words; undefined when they dismissed it. */
export type AskUser = (question: Question, signal?: AbortSignal) => Promise<string[] | undefined>

export const QUESTION_TOOL = {
  type: "function" as const,
  function: {
    name: "question",
    description:
      "Ask the user a question and wait for the answer: to settle a choice only they can make, or " +
      "clarify a request that has no reasonable default. Offer the options you see (the user can " +
      "always type their own answer, so do not add an 'Other' option); put a recommended option " +
      "first and add (Recommended) to its label. Do not use it to ask permission for a tool - " +
      "tools ask for themselves - and do not ask what you can find out by looking.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, complete and on its own." },
        options: {
          type: "array",
          description: "Up to 6 answers to choose from.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "A few words." },
              description: { type: "string", description: "What choosing it means." },
            },
            required: ["label"],
          },
        },
        multiple: { type: "boolean", description: "Whether more than one option may be chosen." },
      },
      required: ["question"],
    },
  },
}

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "")

/** The question as the model sent it, made safe to show: trimmed, deduplicated, at most six options. */
export function parseQuestion(args: unknown): Question {
  const raw = (args && typeof args === "object" ? args : {}) as Record<string, unknown>
  const question = clean(raw.question, 500)
  if (!question) throw new Error("the question is empty")
  const seen = new Set<string>()
  const options: QuestionOption[] = []
  for (const entry of Array.isArray(raw.options) ? raw.options : []) {
    const item = (typeof entry === "string" ? { label: entry } : entry) as Record<string, unknown>
    const label = clean(item?.label, 80)
    if (!label || seen.has(label.toLowerCase()) || /^other\b/i.test(label)) continue
    seen.add(label.toLowerCase())
    const description = clean(item?.description, 160)
    options.push(description ? { label, description } : { label })
    if (options.length === 6) break
  }
  return { question, options, multiple: raw.multiple === true && options.length > 1 }
}

/** What the model is told. */
export function answerText(question: Question, answer: string[] | undefined): string {
  if (!answer || !answer.length) {
    return `The user dismissed the question "${question.question}" without answering. Do not ask it again; carry on with your best judgement, or stop and say what you need.`
  }
  return `The user answered "${question.question}": ${answer.map((each) => `"${each}"`).join(", ")}.`
}
