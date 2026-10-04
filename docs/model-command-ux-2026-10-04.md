# Model command UX

Independent branch `codex/model-command-ux`, based on `6607a15`.
Exact `/model provider/model` matches now rank before longer prefix matches in
both slash palettes. Enter on `/model zai/glm-5.3` selects GLM 5.3 rather than
silently completing GLM 5.3 Flash. Browsing partial names/sections keeps the
catalog order, and a deliberate arrow-key selection still works.

Web Enter while the initial catalog is loading now explains that models are
loading and retains the draft/attachments. Catalog failure has distinct retry
guidance. Commands that don't need models remain available during loading.

Verification: **693 tests**, clean typecheck/JS syntax/diff check. Actual Web
with catalog response deliberately held: loading feedback visible, draft intact;
after release, exact typed model command selects GLM 5.3. Actual 80×24 TUI typed
the same command and selected GLM 5.3. No inference or real-profile writes.

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
git switch codex/model-command-ux
bun typecheck
bun run test
bun run tui
# Another terminal:
bun run web
```

Test `/model zai/glm-5.3` then Enter in both surfaces; the model name must not
say Flash. Type a normal prompt immediately after Web reload and press Enter:
loading feedback must retain it, with no request sent before model selection.
