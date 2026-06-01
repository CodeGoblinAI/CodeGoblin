# CodeGoblin Open-Source Boundaries

CodeGoblin is a local-first fork/customization of OpenCode. This public repository should stay safe to open-source by keeping commercial and hosted-service implementation details outside the tree.

## Public repo owns

- Local CLI, TUI, desktop, and web app behavior.
- Provider adapters and BYOK/local-auth flows.
- CodeGoblin image/audio orchestration, local output paths, retries, and previews.
- Compatibility with inherited OpenCode config and SDK surfaces.
- Public extension points for future hosted features.
- Docs that explain how to run, validate, and contribute without private infrastructure.

## Private repo owns

- Hosted gateway implementation and production routing.
- Billing, Stripe webhooks, pricing logic, invoices, and entitlements.
- Production API keys, provider contracts, and private model-routing rules.
- Hosted market auth backend, account management, and operational dashboards.
- Production analytics, alerting secrets, and private deployment configuration.

## Compatibility identifiers to preserve

These names are intentionally kept until a dedicated migration PR provides aliases, data migration, and release notes:

- `@opencode-ai/*`
- `opencode.json`
- `.opencode/`
- `OPENCODE_*`
- Provider IDs such as `opencode` and `opencode-go`

New CodeGoblin-facing public knobs should use `CODEGOBLIN_*`, `codegoblin`, or `cg` while reading legacy names as compatibility fallbacks where needed.

## Release checklist

Before opening the repo or cutting a public release:

1. Run the secret and tracked-file audit documented in `SECURITY.md`.
2. Confirm no `.env`, `auth.json`, local DBs, logs, generated outputs, screenshots with credentials, or provider response dumps are tracked.
3. Verify the embedded web UI is included for public builds so `codegoblin web` does not fall back to an upstream-hosted UI.
4. Confirm docs point to CodeGoblin public surfaces and only mention OpenCode for attribution or compatibility.
5. Keep production billing/gateway code in the private repo and expose only public contracts here.
