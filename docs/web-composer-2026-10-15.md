# Web multiline composer — October 15 scheduled pass

`codex/web-composer-ux`, independent of the other concern branches and based on `6607a15`. No merge or PR.

## UI work

The actual browser test showed `First line` → Shift+Enter → `Second line` becoming `First lineSecond line`: the Web composer was a single-line input. It is now an accessible, described textarea that grows to 156px, scrolls internally above that, and shrinks after sending/clearing. Enter sends; Shift+Enter inserts a newline, even with a completion menu open.

The footer tells the truth while working: Enter queues and Ctrl+S sends now. Resizing/toggling panels remeasures the composer. Model/mode controls wrap at intermediate widths as well as phone widths. Slightly larger plus/Send targets, bottom-aligned actions and a flat green Send treatment preserve the existing CodeGoblin theme.

## Actual checks and evidence

- Native Shift+Enter produced a real newline; Ctrl+A/C copied exactly the two-line test string; Enter submitted one multiline user message. The field shrank again afterward.
- With `@notes` completion open, Shift+Enter produced `@notes\n`, not a completed/sent mention.
- A 24-line paste stayed at 156px with internal scrolling; no lines were dropped. Three-line editing remained comfortable at 390×844. Send stayed visible, and page overflow was false.
- At 760px with both sidebars visible, model/mode controls stayed inside the composer, without horizontal page overflow.
- The actual UI rendered a local-fixture reply with code/list/table content; screenshots inspected at desktop and phone sizes. Only inference was fake. No paid model, external uploads, sign-in or shared-profile writes.

Screenshots retained under ignored `output/playwright/`:

- `night-web-composer-before.jpg`
- `night-web-composer-after-desktop.jpg`
- `night-web-composer-after-phone.jpg`

These are real application screenshots with disposable fixture content, not mockups. They are local evidence, not committed source assets. Before/after transcript content differs; the composer behavior/geometry is the intended comparison.

**695 tests / 55 files**, clean typecheck, Web JS syntax and whitespace. Three added tests exercise the actual sizing/Stop code and multiline control/shortcut wiring; the native key/paste/copy observations above are separate browser verification. This branch does not include queued-command draft recovery or the earlier connection-error fix; reconcile those shared `app.js` paths during integration.

```powershell
Set-Location C:\Users\shawn\code\CG-Next
git switch codex/web-composer-ux
bun typecheck
bun run test
$env:CODEGOBLIN_DIR = "$PWD\output\home-multiline-profile"
bun run web
```

Home checklist: Shift+Enter without sending, Enter once to send, multiline paste/scroll/copy, clear/shrink, file and slash completion, typing during a reply, Stop, and desktop/760px/390px with both sidebars. Use disposable prompts/workspaces; real model calls may consume allowance.
