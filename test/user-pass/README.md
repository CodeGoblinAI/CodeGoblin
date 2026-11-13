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
