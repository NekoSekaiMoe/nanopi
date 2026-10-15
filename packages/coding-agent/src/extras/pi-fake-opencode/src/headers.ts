import { randomBytes } from "node:crypto";

/**
 * pi-fake-opencode — Identity header construction
 *
 * Pure helpers that build the identity signals the official OpenCode client
 * sends to the OpenCode Zen gateway, plus the scoping logic that decides
 * which requests get the treatment. Kept separate from the module factory
 * so the values are easy to read and update without touching pi plumbing.
 *
 * OpenCode Zen's free tier rejects requests that do not look like they come
 * from the official OpenCode app:
 *
 *   Error: OpenAI API error (403):
 *   {"type":"FreeTierError","message":"Error from provider (Console):
 *    OpenCode's free tier can only be used from within OpenCode"}
 *
 * Black-box verification (2026-10, against the 1.19.0 npm client and the
 * live gateway; details and experiment log in README) shows the gate checks
 * three things and all three must hold:
 *
 *   1. User-Agent must be the official composite form:
 *        opencode/{version} ai-sdk/provider-utils/{n} runtime/bun/{n}
 *      e.g. "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14".
 *      The 2-segment `opencode/{version}` and 4-segment
 *      `opencode/{channel}/{version}/{client}` forms are both rejected.
 *   2. `x-opencode-session` / `x-opencode-session-id` must carry a
 *      well-formed DESCENDING opencode identifier and `x-opencode-request`
 *      an ASCENDING one (`ses_`/`msg_` + 12 lowercase hex of the low 48
 *      bits of (ms*0x1000 + counter), optionally NOT-ed, + 14 base62
 *      chars — opencode `packages/schema/src/identifier.ts`).
 *   3. The request's system message must START with a known official
 *      OpenCode prompt (the session title-generator prompt works; anything
 *      may be appended after it). Enforced in index.ts.
 *
 * None of this is transport-dependent: the same request passes from curl,
 * Node/undici, and Bun once the three signals are right.
 */

/**
 * OpenCode client version to impersonate.
 *
 * The gateway rejects stale versions with `UpgradeRequired`, so this must
 * track a recent OpenCode release (npm `opencode-ai` latest at the time of
 * the 2026-10 re-verification). Override at runtime with the
 * `PI_FAKE_OPENCODE_VERSION` env var, or replace the whole User-Agent via
 * `PI_FAKE_OPENCODE_UA`, when the gateway starts rejecting older
 * fingerprints.
 */
export const DEFAULT_OPENCODE_VERSION = "1.19.0";

/** `ai-sdk/provider-utils` version embedded in the official User-Agent. */
export const DEFAULT_PROVIDER_UTILS_VERSION = "4.0.23";

/** Bun runtime version embedded in the official User-Agent. */
export const DEFAULT_BUN_VERSION = "1.3.14";

/**
 * pi provider ids that target OpenCode infrastructure.
 *
 * - `opencode`     — pi's built-in "OpenCode Zen" provider (OPENCODE_API_KEY)
 * - `opencode-go`  — pi's built-in "OpenCode Go" provider (OPENCODE_API_KEY)
 */
export const OPENCODE_PROVIDER_IDS = new Set(["opencode", "opencode-go"]);

/** Base-URL substring that marks a custom provider as pointing at Zen. */
export const OPENCODE_BASEURL_MARKER = "opencode.ai";

const IDENTIFIER_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Env vars read as truthy when set to 1/true/yes/on (case-insensitive). */
function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** Parse a comma-separated env var into a trimmed, lower-cased set. */
function envList(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
  );
}

/** Random bytes as base62-ish characters, mirroring opencode's identifier tail. */
function randomChars(count: number): string {
  const bytes = randomBytes(count);
  let out = "";
  for (const byte of bytes) out += IDENTIFIER_CHARS[byte % IDENTIFIER_CHARS.length];
  return out;
}

let lastTimestamp = 0;
let counter = 0;

/**
 * Generate an opencode identifier body: 12 lowercase-hex chars — the low 48
 * bits of (timestamp*0x1000 + per-process counter), NOT-ed for descending
 * ids — plus 14 random alphanumerics, exactly like `Identifier.create()` in
 * opencode's `packages/schema/src/identifier.ts`.
 *
 * Session ids are DESCENDING (newest-first sort); message ids are ASCENDING.
 * The gateway validates both directions — an ascending session id is
 * rejected with `FreeTierError` even when every other signal is correct.
 */
function identifierBody(descending: boolean): string {
  const timestamp = Date.now();
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  return time + randomChars(26 - 12);
}

/**
 * Build the OpenCode client's User-Agent string.
 *
 * Mirrors the official client (`App.useragent` composed with the AI SDK and
 * runtime segments in the 1.19.x line), e.g.:
 *
 *   opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
 *
 * Priority:
 *   1. `PI_FAKE_OPENCODE_UA`      — full string override
 *   2. `PI_FAKE_OPENCODE_VERSION` — opencode version segment override
 *   3. Defaults above
 */
export function buildUserAgent(): string {
  const full = process.env.PI_FAKE_OPENCODE_UA?.trim();
  if (full) return full;

  const version =
    process.env.PI_FAKE_OPENCODE_VERSION?.trim() || DEFAULT_OPENCODE_VERSION;
  return [
    `opencode/${version}`,
    `ai-sdk/provider-utils/${DEFAULT_PROVIDER_UTILS_VERSION}`,
    `runtime/bun/${DEFAULT_BUN_VERSION}`,
  ].join(" ");
}

/** Per-pi-session cache: one stable opencode session id per pi session. */
const sessionIds = new Map<string, string>();

/**
 * Build the `x-opencode-session` / `x-opencode-session-id` value for a pi
 * session: a stable, well-formed DESCENDING opencode session id
 * (`ses_` + 26 chars). Cached per pi session id so retries and follow-up
 * requests within one pi session reuse the same value, just like the real
 * client would.
 */
export function buildSessionId(piSessionId: string): string {
  const existing = sessionIds.get(piSessionId);
  if (existing) return existing;

  const generated = `ses_${identifierBody(true)}`;
  sessionIds.set(piSessionId, generated);
  return generated;
}

/**
 * Build the `x-opencode-request` value: a fresh ASCENDING message id
 * (`msg_` + 26 chars) per request, mirroring opencode's user-message id.
 */
export function buildRequestId(): string {
  return `msg_${identifierBody(false)}`;
}

/**
 * The `x-opencode-client` value: opencode's client flavor flag, defaulting
 * to "cli" (overridable via OpenCode's own `OPENCODE_CLIENT` env var).
 */
export function buildClient(): string {
  return process.env.OPENCODE_CLIENT?.trim() || "cli";
}

/**
 * The `x-opencode-project` value. The official CLI sends the literal
 * `global` for ad-hoc runs (observed in the 1.19.0 client's request log);
 * project-scoped runs send the resolved project id. We send `global`.
 */
export function buildProjectId(): string {
  return "global";
}

/**
 * Decide whether a request should carry the OpenCode identity.
 *
 * Spoofs when any of the following holds:
 *
 *   1. `PI_FAKE_OPENCODE_ALL` is set truthy — spoof every request, useful
 *      when a proxy in front of Zen forwards client headers verbatim.
 *   2. The model's provider is `opencode` / `opencode-go`, or listed in the
 *      comma-separated `PI_FAKE_OPENCODE_PROVIDERS` env var (for custom
 *      provider ids that point at Zen).
 *   3. The model's base URL contains `opencode.ai` (models.json providers
 *      configured with `https://opencode.ai/inference/v1` or similar).
 *
 * Untouched requests keep pi's own identity, so unrelated providers are never
 * affected.
 */
export function shouldSpoof(
  provider: string | undefined,
  baseUrl: string | undefined,
): boolean {
  if (envFlag("PI_FAKE_OPENCODE_ALL")) return true;

  if (provider) {
    const id = provider.toLowerCase();
    if (OPENCODE_PROVIDER_IDS.has(id)) return true;
    if (envList("PI_FAKE_OPENCODE_PROVIDERS").has(id)) return true;
  }

  if (baseUrl && baseUrl.toLowerCase().includes(OPENCODE_BASEURL_MARKER)) {
    return true;
  }

  return false;
}
