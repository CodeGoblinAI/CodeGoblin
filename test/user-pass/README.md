# User passes

Scripts that drive CG-Next the way a person does: the terminal app in a real
PTY and the web app in headless Chromium, both against a fake model
(`fakeModel` in `harness.mjs`), in throwaway profile and project folders.

    node test/user-pass/pass-projects.mjs
    node test/user-pass/shots.mjs        # screenshots into output/shots

They are not part of `bun run test`. `harness.mjs` loads node-pty from the
CodeGoblin fork's `node_modules` and Playwright from the npx cache, at the
paths written at its top; change those if either moves.

The web harness refuses to send a prompt unless the fixture model is selected.
`pass-balance-connect.mjs` is the one script that makes a real (free,
read-only) provider call.

Run them one at a time: under load a few (`pass-fav-dialog`, `pass-idle-compact`,
`pass-small`) can fail on timing alone.

## Real-model checks

The `real-*.ts` scripts and `pass-real.mjs` call a real provider and cost money,
a fraction of a cent each. They read a stored key into their own process only,
never print it, and use a throwaway profile.

    bun test/user-pass/real-image.ts [provider/model]   # is a picture really seen: by full path, and through read_file
    bun test/user-pass/real-refuseless.ts [model]       # Refuseless: effort levels, a tool round trip, usage
    bun test/user-pass/real-jobs.ts [provider/model]    # does a model start a dev server in the background unprompted
    bun test/user-pass/real-runaway.ts [provider/model] # a command far bigger than it looked: is it handed back, and what does the model do
    bun test/user-pass/real-turn-profile.ts [provider/model] [effort]   # where one simple task's time goes, step by step
    bun test/user-pass/real-effort-time.ts [provider/model] [efforts]   # the same tiny task at each reasoning effort
    bun test/user-pass/real-cache-check.ts              # prompt-cache reads
    bun test/user-pass/real-cost-check.ts [model ...]   # compares app spend readout vs provider balance to 6 decimals
    bun test/user-pass/real-everyday-tasks.ts           # everyday file/folder tasks in a sandboxed temp tree
    bun test/user-pass/real-rollback.ts                 # 0.3 <-> 0.4 shared-profile coexistence and rollback
    node test/user-pass/pass-real.mjs                   # a whole terminal turn on a real model

## A real window

A PTY shows text, not what the window looks like. `tui-window.mjs` opens the app
in Windows Terminal on a fake model and prints its TITLE and PID; `rt.ps1` types
into it and saves pictures to `output/shots`:

    node test/user-pass/tui-window.mjs 110 34
    powershell -File test/user-pass/rt.ps1 <PID> <TITLE> name "k:/model{ENTER}" "w:900" "s:model"

Stop the `tui-window.mjs` process when done; it keeps the fake model up.

## Background jobs

`pass-jobs-tui.mjs` and `pass-jobs-web.mjs` have a scripted model start a real server process in the
background, then check the running-jobs indicator, `/jobs` (output and Stop), that the process is
really gone after Stop, and (terminal) that quitting ends what is still running.

## Watching a command

`pass-watch-commands.mjs` (terminal) and `pass-watch-web.mjs` (browser) run a command that prints for a
few seconds and one that never ends. They check the running row (elapsed time, last five lines), that a
finished row opens and folds (click; Ctrl+O in the terminal, Enter in the browser), that a command
outliving its wait comes back to the model as a background job rather than being killed, and that
while a turn runs `/jobs` opens at once and two typed messages are both kept and sent in order.
In `tui-window.mjs`, "watch" and "forever" in a prompt run the same two commands in a real window.

## Unexpected errors

`pass-crash.mjs` makes the terminal app throw (F12, only with `CODEGOBLIN_DEBUG_CRASH` set: `now`,
`later` for a background failure, `draw` for one while drawing). One error is shown, logged to
`log/tui-crash.log` and survived; repeated ones, or one while drawing, end the app with the terminal
handed back and the error printed.

## Voice

`pass-voice-tui.mjs` and `pass-voice-web.mjs` run the real speech model against a spoken test
recording made with Windows' own voice, so no microphone is needed. They look for the model in
`CG_VOICE_MODEL_DIR`, CG-Next's own data folder, then DeepSeek Harness's (`~/.dsh`), and skip when
there is none. `CG_VOICE_FAKE_WAV` makes the terminal's recorder return that file instead of
recording. To try the real microphone, run `tui-window.mjs` with `CG_VOICE_MODEL_DIR` set.

## Verification layers

Alongside these E2E passes, `bun run test` runs seeded property-based tests (`test/properties.test.ts`,
override seed with `CG_PROP_SEED=<n>`) and migration/surface differential tests
(`test/differential-fork.test.ts`). See `REVIEW.md` at the repo root for diff-triggered reliability
rules and `.claude/skills/verify/SKILL.md` (also `.codegoblin/skills/verify/SKILL.md`) for the full
`/verify` checklist.
