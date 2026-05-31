# CodeGoblin Monetization Scaffold

This repository keeps monetization intentionally scaffold-only. The goal is to let the open-source CodeGoblin app compile, run locally, and expose clean seams without shipping private business logic.

## Public concepts

CodeGoblin may eventually support hosted conveniences such as:

- A hosted model gateway for users who do not want to bring every provider key.
- Optional subscription or usage-based plans.
- Account-backed balance/hoard displays.
- Curated market integrations and hosted auth helpers.

Those concepts can appear in public UX copy, docs, interfaces, and no-op boundaries, but the implementation belongs outside this repository.

## Public implementation rules

- Public code can define neutral interfaces, local fallbacks, and no-op adapters.
- Public code can read local environment variables and user config.
- Public code must not contain Stripe webhooks, production gateway URLs, private pricing tables, provider contracts, production keys, or entitlement checks.
- Public code should treat hosted features as optional. Local BYOK flows must continue to work without a CodeGoblin account.
- Public docs should explain that provider costs are charged by the user's configured provider unless a future hosted CodeGoblin plan is explicitly connected.

## Private implementation contract

The future private repo can implement these behind stable public seams:

- Account identity and session exchange.
- Hosted model gateway routing.
- Billing/entitlements.
- Live balance and usage rollups.
- Market auth callbacks and managed integration credentials.
- Operational dashboards, alerts, and provider contract logic.

## Current status

- Local image/audio generation and output management live in this repo.
- Provider keys remain local unless a user intentionally connects an external provider.
- Hosted provider compatibility is still routed through inherited provider IDs where needed.
- The only public monetization code should be documentation and neutral boundary declarations.

See also `docs/OPEN_SOURCE_BOUNDARIES.md` and `SECURITY.md`.
