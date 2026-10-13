# Agent Note: Reauthorize Sign in with ChatGPT with the stored issued client ID

Status: implemented

## Problem

Every OpenAI login went through first-time dynamic registration: `client_id=dynamic_agent_client` plus the installation's stable `ext_agent_host_id`, then exchanged the returned code with the freshly issued `client_id`. OpenAI's [token-sharing flow documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) defines `dynamic_agent_client` as a **first-time entrypoint only** and requires later sign-ins for the same agent host to reuse the previously issued client ID. When nanopi re-registered a host OpenAI already knew (re-login after logout, expired credential, or any second sign-in on the machine), the code exchange answered `400 {"error": "invalid_grant"}` and login always failed.

Diagnosis was obfuscated because `https://auth.openai.com/api/accounts/oauth/token` masks every grant failure (unknown client, bad code, PKCE mismatch — probed directly) as the same `invalid_grant` body, and upstream pi-mono (the flow's origin) had not fixed it either.

## Decision

The login flow treats the issued client ID as durable per-installation state and follows the documented two-phase protocol:

- `Models.login` reads the provider's stored OAuth credential and passes it to flows as the new `LoginOptions.currentCredential` (apps keep supplying only `getDeviceId`/`agentName`).
- Login starts authorization with the stored issued client ID when one exists (omitting `agent_name_hint`, which the docs restrict to registration) and falls back to `dynamic_agent_client` only when the store has none.
- Callback handling is mode-aware: a registration callback must carry the issued `client_id`; a reauthorization callback may omit it (the pending ID is retained) and must never carry a different one — the flow rejects it with a "log out first to connect a different ChatGPT account" error instead of silently replacing the registration.
- One self-healing retry: when a code exchange returns `invalid_grant` and the attempt's effective client ID differs from the one used to start it (dynamic registration for an already-known host), login discards the code and restarts authorization with that issued ID — fresh state, nonce, PKCE, and callback server. After the restart the IDs are equal, so the retry can never loop. This covers the store having lost the credential while OpenAI still remembers the host.
- Token-endpoint errors now carry the parsed OAuth `error` code (`OAuthTokenRequestError`) so only `invalid_grant` triggers the retry; the user-facing message text is unchanged.

## Alternatives considered

- Always register dynamically and rely on the retry alone: rejected — every re-login would burn a doomed browser round-trip first and permanently fight the documented "reuse the issued client ID" contract; the retry remains only as recovery for a lost credential.
- Migrate the flow to the current Codex CLI endpoints (`/oauth/authorize` + `/oauth/token`, static client `app_EMoamEEZ73f0CkXaXp7hrann`): rejected — that is Codex's first-party client with its own consent surface and id_token-to-API-key trade; the third-party token-sharing flow nanopi implements has its own documented endpoints, and `packages/ai/src/auth/oauth/openai-codex.ts` already covers the Codex-style login for the `openai-codex` provider.
- Accept a different client ID in a reauthorization callback (account switching while logged in): rejected — the docs explicitly say to reject it rather than replace the selected account's registration; nanopi's logout-then-login (no stored ID → fresh registration) already covers switching accounts.
- Retain the ID token and send `id_token_hint` on returning sign-in: deferred — it only skips the account-selector screen; the hint is optional per the docs and requires storing `id_token` on the credential. Can be added later without protocol changes.

## Consequences

- Benefit: re-login works; returning sign-ins see the account selector and redirect without a consent screen; callback behavior now matches the documented contract instead of assuming every login is a first registration.
- Cost: connecting a *different* ChatGPT account requires logging out first (nanopi keeps one credential per provider, and a mismatched client ID is now rejected); the self-healing path costs one extra browser round-trip when the store lost the credential but OpenAI remembers the host; `LoginOptions` gained a Models-injected field, so callers that invoke `OAuthAuth.login` directly (the `packages/ai` dev CLI) stay on dynamic registration.
- Testing: `packages/ai/test/openai-chatgpt-oauth.test.ts` covers reauthorization with the stored ID (hint omitted, callback without `client_id`), rejection of a mismatched callback client ID, the invalid_grant restart with the issued ID (fresh state asserted), and no restart when the stored ID itself is rejected.

Audit: searched `.agents/notes/` (proposed/implemented) for openai/chatgpt/oauth/login — no active note covers this flow; this is its first record.
