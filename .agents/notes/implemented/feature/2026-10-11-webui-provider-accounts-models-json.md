# Agent Note: Webui provider accounts map onto models.json; sync/login/remote UI removed

Status: implemented

## Problem

The webui's model-settings dialogs were dead UI against the fork's server:
`/config` returned `providers: []` with no preset/protocol catalogs, and
`/provider-accounts` answered 400 "not available in the webui yet" — so the
add-provider dialog could not select a protocol ("选择不了接口") and the preset
tab was permanently disabled ("预设服务商点不了"). Separately the sidebar shipped
three controls that do nothing in nanopi: the sync toggle (switches to the
unimplemented `/live` transport), the account login (an AtomCode account
system nanopi does not have), and the PGY remote-access phone button.

## Decision

- One webui "provider account" is one entry in the `models.json` `providers`
  map (`src/modes/webui/provider-accounts.ts`): vendor presets and generic
  protocols are hardcoded catalogs (`PROVIDER_PRESETS`/`PROVIDER_PROTOCOLS`,
  same shape the frontend expects); create/edit/delete rewrites the file,
  preserving foreign fields (`$schema`, `headers`, …), and the server then
  calls `modelRuntime.refresh({ allowNetwork: false })` so the new models
  appear without a restart. API keys are written to models.json's documented
  `apiKey` field and never returned to the page.
- `/providers/discover-models` lists models from the endpoint itself
  (`GET {base}/models`, or `/v1/models` with `x-api-key` for
  anthropic-compatible), so the discovery button works for gateways and local
  servers alike.
- The sync toggle, sidebar login UI, and remote-access buttons/dialog are
  deleted from the frontend; `LoginButton.tsx` and `lib/signIn.ts` go with
  them (the page-token 401 gate via `AuthRequired` at mount stays).
- Landing greeting: a random classical Chinese poetry line in zh (pools in
  `webui/src/lib/greeting.ts`); English keeps the fixed i18n greeting.
  User-visible branding reads `NanoPi` (title, manifest, offline page,
  sidebar/landing); command examples stay lowercase `nanopi`.

Related: [port-atomcode-webui](../architecture/2026-10-11-port-atomcode-webui.md)
documented the stubs this note partially fills in.

## Alternatives considered

- Map accounts onto agent settings instead of models.json: rejected —
  models.json is the documented way to add compatible endpoints, already
  feeds ModelRuntime composition, and survives restarts without new plumbing.
- Keep the login/remote UI behind a capability flag: rejected — nanopi has no
  backend for either; dead controls were the complaint, not the lack of them.
- Implement `set_default` on account creation: deferred — the UI tolerates its
  absence and the client switches models itself after creation; wiring it into
  settingsManager default-provider semantics can ride a later change.

## Consequences

- Benefit: the settings' add-provider flow works end-to-end (preset vendors,
  custom protocols, discovery, per-account models) against nanopi's real
  config; the sidebar only offers what works.
- Cost: preset ids that collide with builtin providers (for example `openai`)
  override the builtin via models.json semantics — intended per the docs, but
  users must pick distinct ids to keep both. Deleting an account removes its
  models.json entry wholesale. The catalogs are hardcoded; new vendors need a
  server edit.
