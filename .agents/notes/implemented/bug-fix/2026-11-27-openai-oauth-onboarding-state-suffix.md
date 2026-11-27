# Agent Note: Sign in with ChatGPT accepts the onboarding state suffix

Status: implemented

## Problem

`Failed to login to OpenAI: OAuth state mismatch` came from `packages/ai/src/auth/oauth/openai-chatgpt.ts`: it required the callback's `state` to equal the generated value byte for byte. OpenAI's sign-in platform now appends `.onboarding_entrypoint=life_sciences` to the echoed `state` for some accounts, and OpenAI's own CLI accepts that exact suffix before validating the nonce (see [openai/codex#36635](https://github.com/openai/codex/pull/36635)). A valid callback therefore failed before any code exchange (issue [#854](https://cnb.cool/shinytale/agent/nanopi/-/issues/854)).

## Decision

Callback validation accepts either the exact state or that state followed by the single allowlisted suffix. Any other suffix, a repeated suffix, or a suffix on a different nonce still fails with `OAuth state mismatch`. The suffix is only stripped for validation; the authorization request and token exchange are unchanged.

`packages/ai/test/openai-chatgpt-oauth.test.ts` covers registration callbacks with the suffix, an unknown suffix, and a repeated suffix. The suffix case also asserts the authorization URL was built with the plain state, so the extra metadata never travels into the request.

## Alternatives considered

- Ignore `state` on callback: rejected — it would remove the CSRF binding for both dynamic registration and reauthorization; the report is from a provider behavior change, not from state checks being obsolete.
- Accept any state that starts with the nonce: rejected — OpenAI allowlists one suffix and its CLI rejects unknown or repeated suffixes; a prefix check would also accept values the provider never emits.
- Patch `packages/ai/src/auth/oauth/openai-codex.ts` too: rejected for this fix — issue #854 names the `openai` provider's `OAuth state mismatch`, while the Codex flow reports `State mismatch` and uses different endpoints. The Codex flow can be evaluated separately if the same suffix is observed there.

## Consequences

- Benefit: sign-in completes for callbacks carrying the documented onboarding suffix; malformed states stay rejected.
- Cost: validation knows one provider-owned suffix constant. A future onboarding entry point needs another explicit entry, which is preferable to weakening the comparison.
- Verification: targeted vitest run for `packages/ai/test/openai-chatgpt-oauth.test.ts` passes all 14 cases.
