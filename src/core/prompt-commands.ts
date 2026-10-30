/**
 * Slash commands that ship as prompts: /init, /review, /grill, /goal, /teach.
 *
 * Each is a template like a custom command's, expanded with $ARGUMENTS and
 * sent as the message. They come last, so a project's or the user's own file
 * of the same name replaces one - a team can have its own /review.
 *
 * /grill, /goal and /teach are Shawn's, carried over from the fork. /init and
 * /review are written for CG-Next rather than copied from the fork, whose
 * versions are upstream OpenCode's.
 */
export type PromptCommand = { name: string; description: string; argumentHint?: string; template: string }

const INIT = `Set up or improve this project's AGENTS.md: the file CG-Next (and Claude Code, Codex and others) read at the start of every conversation here.

Focus, if given: $ARGUMENTS

## Find out, don't guess

Read before writing. Look for:
- How to build, run, test (all of it, and one test), lint and typecheck - the exact commands, from package.json scripts, Makefile, pyproject, CI workflows or similar. Prefer commands you have seen work in CI over ones you infer.
- The layout: the few directories and entry points someone needs to know first, and what each is for.
- Conventions a newcomer would get wrong: naming, error handling, where tests go, commit message style (check \`git log\`), generated files not to edit.
- Gotchas: environment variables, required services, platform quirks, slow or flaky tests.
- Existing agent guidance to fold in: CLAUDE.md, .cursorrules, .cursor/rules, .github/copilot-instructions.md, CONTRIBUTING.md.

## Write it

- Short and specific: commands in code blocks, facts with file paths. Skip anything obvious from the code or true of every project.
- If AGENTS.md exists, improve it in place: keep what is still true, fix what is stale, add what is missing. Do not throw away the owner's wording without reason.
- If a section would only be a guess, leave it out or ask.

Show what you plan to write (or the changes, for an existing file) and ask before writing it. Then write AGENTS.md at the project root.`

const REVIEW = `Review code changes for real problems. Read-only: do not edit files, stage, commit or push.

What to review: $ARGUMENTS
- Nothing given: the uncommitted changes - \`git diff HEAD\` plus untracked files from \`git status --porcelain\`.
- A commit: \`git show <commit>\`.
- A branch: the diff from where it left the default branch - \`git diff $(git merge-base origin/HEAD <branch>)...<branch>\` (fall back to main or master).
- A pull request number or URL: \`gh pr diff <pr>\` and \`gh pr view <pr>\` for its description.

## How

1. Get the diff and understand the intent first (commit messages, PR description, the surrounding code).
2. For each change, read enough of the surrounding code to judge it: callers, the types involved, the tests. A finding you have not checked against the real code is a guess.
3. Look for: incorrect logic and edge cases, broken error handling, races, resource leaks, security problems (injection, secrets, unsafe paths, missing permission checks), behaviour changes the author may not intend, missing or wrong tests for changed behaviour, and changes that contradict the project's own conventions.
4. Leave out style preferences and nitpicks unless they hide a bug.

## Report

Most severe first. For each finding: \`file:line\`, one sentence on what is wrong, and the concrete input or situation that goes wrong. Say how sure you are when it is not certain. If you found nothing worth fixing, say so plainly - do not pad the list.`

const GRILL = `Before doing any work, interrogate the request until it is unambiguous. Ask the questions whose answers would actually change what you build - then wait.

The task to pin down (or the pending request in this conversation if this is blank):
$ARGUMENTS

## Do this now, before touching anything

1. Read enough of the codebase/config to answer for yourself whatever the repo already makes clear. Do not ask about things you can look up.

2. Find the decisions that are genuinely underspecified and would send the implementation in different directions. Focus on:
   - **Scope & done-criteria**: what is explicitly in and out; what "finished" looks like.
   - **Forks in the road**: choices where two reasonable answers lead to very different work (approach, library, data shape, API surface, where code lives).
   - **Constraints**: performance, compatibility, security, style, things that must not change.
   - **Unknown inputs**: credentials, environments, endpoints, file locations, sample data only the user has.
   - **Assumptions you'd otherwise just make** - surface them so a wrong guess doesn't cost a rewrite.

3. Ask them as ONE batch in a single message: a handful of high-leverage questions, numbered, each with concrete options where you can, plus your recommended default so the user can just accept. Do not dribble questions out one at a time, and do not ask things the code already answers. Then end your turn.

4. Wait for the answers. Do not start implementing, editing, or running commands until the user has responded. If they skip a question, proceed with the recommended default and say which default you took.

Then restate the sharpened task in one or two sentences and get to work.`

const GOAL = `You are in GOAL mode. Do not stop until the goal below is fully and verifiably complete, end to end. Treat "I think that's it" as a signal to double-check, not to stop.

## The goal

$ARGUMENTS

## How to run

- Keep working autonomously. Plan the goal into concrete steps, then execute them with your tools, one after another, without pausing to hand control back after each small step.
- Do not end your turn just because you finished a step or hit a natural stopping point. End it only when the whole goal is met, or you are genuinely blocked on something only the user can provide (a secret, a decision you cannot make safely, an external action you cannot take).
- When you believe you are done, VERIFY before you say so: run the build/tests/linters, re-read the goal, and confirm each part is actually satisfied. If verification fails, fix it and verify again. Don't declare success on an unverified assumption.
- If you get stuck, try a different approach before giving up. Report dead ends, but keep pursuing the goal.
- Keep the user oriented with brief progress notes as you go, but don't stop for approval on reversible steps that clearly serve the goal. Still respect the usual guardrails: confirm genuinely destructive or outward-facing actions, and never bypass a permission prompt.

## Running time

Goal mode runs unbounded by default - it keeps going until the goal is complete or your context/tokens run out. That is intentional. The user can stop it at any time (Esc in the terminal, Stop in the browser). Every so often, when you have done a large chunk of work with no user contact, post a one-line checkpoint of what's done and what's left so the user can course-correct - but keep going unless they interrupt.

Now: restate the goal in one sentence, lay out your plan, and begin.`

const TEACH = `Turn a hard-won learning into a reusable CodeGoblin skill - proposal first, then write it only after the user approves.

What to capture (from the user, or infer from this conversation if they didn't say):
$ARGUMENTS

## 1. Understand the learning

Figure out the specific, non-obvious knowledge worth saving. Good skills capture things a fresh agent would get wrong without help: a gotcha you just hit, a multi-step workflow, a project convention, a tool's real behavior. If the trigger is vague, read the relevant code/config/history to pin down the concrete facts - do not save generic advice.

Every candidate fact should pass: "Would a capable agent likely miss or misapply this without being told?" If not, drop it.

## 2. Draft a learning proposal (do NOT write the skill yet)

Present a short proposal and ask the user to approve, edit, or reject it, then end your turn and wait. The proposal is:

- **Skill name**: short kebab-case slug (this becomes the folder name)
- **When to use / description**: one line the model will match against to decide relevance - the single most important field
- **What it captures**: 2-5 bullets of the actual knowledge
- **Why it's worth a skill**: what breaks or slows down without it

Keep it tight. If several unrelated learnings came up, propose the most valuable one (or a small set), not a grab-bag.

## 3. Write it on approval

Only after the user approves, create \`.codegoblin/skills/<name>/SKILL.md\` with YAML frontmatter and a focused body:

\`\`\`markdown
---
name: <kebab-case-slug>
description: <one line - when should the model reach for this skill>
---

# <Title>

<The actual, verifiable knowledge. Exact commands, file:line references,
concrete gotchas. Short sections and bullets. No filler, no generic advice,
nothing you could not verify.>
\`\`\`

Rules:
- The \`description\` is what gets matched for relevance - make it specific and trigger-oriented ("Use when ..."), not a summary.
- Include only what you verified. Prefer exact commands and real paths over prose.
- If a skill with that name already exists, improve it in place instead of duplicating.
- Keep it small. A skill that tries to cover everything gets loaded for nothing.

After writing, tell the user the path and that it will load automatically when relevant. Do not restate the whole skill back to them.`

export const PROMPT_COMMANDS: PromptCommand[] = [
  { name: "init", description: "guided AGENTS.md setup for this project", argumentHint: "[focus]", template: INIT },
  { name: "review", description: "review changes: uncommitted by default, or a commit, branch or PR", argumentHint: "[commit|branch|pr]", template: REVIEW },
  { name: "grill", description: "ask the clarifying questions that matter before starting", argumentHint: "[task]", template: GRILL },
  { name: "goal", description: "work autonomously until the goal is verifiably done (unbounded)", argumentHint: "<goal>", template: GOAL },
  { name: "teach", description: "turn a learning into a project skill, proposal first", argumentHint: "[what to capture]", template: TEACH },
]
