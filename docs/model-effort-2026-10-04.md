# Per-model reasoning effort

Independent branch `codex/model-effort`, based on `6607a15`.
TUI effort picker, `/effort`, Web Settings and actual inference now use the
exact provider/model preference in `settings.json`'s `effortByModel` map.
Switching models or restarting doesn't transfer one model's choice to another.
`auto` is a saved choice; unsupported models still never receive effort fields.
Old global preferences remain effective until the first model-scoped save;
afterward unconfigured models default to auto. Up to 256 valid choices retained.
The Web settings endpoint validates the model and level; it doesn't accept
arbitrary wholesale preference-map replacement from a browser request.

Verification: **696 tests**, clean typecheck/JavaScript syntax/diff check.
Actual Web model picker: GLM 5.3 high, DeepSeek V4 Pro low, return to GLM high,
page reload still high. Actual 80×24 TUI picker/switching exercised in the same
isolated profile. No model inference requested for these preference checks.

The user pass also found an existing Web slash-completion ambiguity: Enter on
the exact `/model zai/glm-5.3` can complete the earlier `glm-5.3-flash` prefix.
This is a separate model-command concern; picker clicks choose the exact model.

## Test (PowerShell)

```powershell
Set-Location 'C:\Users\shawn\code\CG-Next'
git switch codex/model-effort
bun typecheck
bun run test
bun run tui
```

Choose GLM 5.3 in the model picker, `/effort high`; choose another model,
`/effort low`; return to GLM and open `/effort`. Quit/restart and check again.
In a second terminal run `bun run web` and repeat using the model picker and
Settings → Reasoning effort (this model). Both surfaces share the same profile.
Use an isolated `CODEGOBLIN_DIR` if you don't want to change real preferences.
