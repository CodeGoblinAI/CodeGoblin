# Stopped answer restore — independent concern branch

`codex/stopped-resume`, based on `codex/phase2-hardening` (`6607a15`), not merged; no PR.

Aborted SSE/CLI turns preserve their accumulated visible answer text, plus `stopped: true` session metadata. Unexecuted partial tool proposals are discarded; already-saved tool calls receive normal stopped results. Approval stops and autonomy-checkpoint stops also persist a marker. Subsequent inference receives a plain-language unfinished-answer note, not unknown metadata API fields.

Web reopen and TUI `/resume` render the marker. The TUI also shows `stopped` in the live transcript, not only its status bar. Frontends cover an abort before the generator starts. Reasoning text is not newly persisted; this concern is visible answer text.

695 tests pass, typecheck and Web syntax/diff checks clean. Three new tests use a real SSE server, CLI transport seam and real permission gate; they cover partial round-trip, provider wire fields and pending-tool closure. Actual Web mid-stream Stop → server restart → sidebar Resume preserved “Partial answer survives stop.” and one stopped marker. Actual 80×24 TUI Ctrl+C mid-stream → `/resume` preserved the same text/marker and did not quit. Local fixture only; no paid inference.

Harness notes: the composer Send button becomes the visible Stop control; the old hidden `#stop` is not the user action. A slow fixture needs `idleTimeout: 255`, like the actual Web server. Its default timeout caused a test-induced socket error in an early attempt; the corrected fixture passed. Tests wait for the current answer, not matching an earlier transcript.

```powershell
Set-Location C:\Users\shawn\code\CG-Next
git switch codex/stopped-resume
$env:CODEGOBLIN_DIR = "$PWD\output\home-stop-test"
bun run tui -- --model codex/default
# Or: bun run web
```

Test a small streaming answer: stop after visible words, resume, restart/resume, continue. Also stop at an approval. Expect partial text and one marker; never execution of incomplete proposed calls. Integration with the other independent branches still requires a conflict-aware pass.
