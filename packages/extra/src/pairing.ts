/**
 * CLI-to-webui pairing codes: short one-time codes with expiry, constant-time
 * comparison, and attempt limiting. The webui server prints code + URL at
 * startup; the browser exchanges the code at POST /extra/pair for the session
 * bearer token, replacing the long token-in-URL handoff.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** Crockford-like base32 without easily confused glyphs (0/O, 1/I/L). */
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const CODE_LENGTH = 8;

export class PairingError extends Error {
	readonly code: "expired" | "invalid" | "locked";

	constructor(message: string, code: "expired" | "invalid" | "locked") {
		super(message);
		this.code = code;
	}
}

export interface PairingSession {
	/** Secret code bytes; never stored as the raw string comparison source. */
	secret: Buffer;
	expiresAt: number;
	attempts: number;
	consumed: boolean;
}

export class PairingManager {
	private session: PairingSession | undefined;
	private readonly ttlMs: number;
	private readonly maxAttempts: number;

	constructor(ttlMs: number = DEFAULT_PAIRING_TTL_MS, maxAttempts: number = DEFAULT_MAX_ATTEMPTS) {
		this.ttlMs = ttlMs;
		this.maxAttempts = maxAttempts;
	}

	/** Generate (replacing any previous) a pairing code. */
	generate(now = Date.now()): { code: string; expiresAt: number } {
		const bytes = randomBytes(CODE_LENGTH);
		let code = "";
		for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
		this.session = {
			secret: Buffer.from(code, "utf8"),
			expiresAt: now + this.ttlMs,
			attempts: 0,
			consumed: false,
		};
		return { code, expiresAt: this.session.expiresAt };
	}

	private activeSession(now: number): PairingSession | undefined {
		const session = this.session;
		if (!session) return undefined;
		if (session.consumed) return undefined;
		if (now >= session.expiresAt) return undefined;
		return session;
	}

	/** Constant-time code verification; consumes the code on success. */
	verify(presented: string, now = Date.now()): void {
		const session = this.activeSession(now);
		if (!session) throw new PairingError("pairing code expired or already used", "expired");
		if (session.attempts >= this.maxAttempts) {
			throw new PairingError("too many invalid attempts; restart nanopi webui for a new code", "locked");
		}
		const presentedBuffer = Buffer.from(presented.trim().toLowerCase(), "utf8");
		const matches =
			presentedBuffer.length === session.secret.length && timingSafeEqual(presentedBuffer, session.secret);
		if (!matches) {
			session.attempts++;
			const remaining = this.maxAttempts - session.attempts;
			if (remaining <= 0) {
				throw new PairingError("too many invalid attempts; restart nanopi webui for a new code", "locked");
			}
			throw new PairingError(`invalid pairing code (${remaining} attempts left)`, "invalid");
		}
		session.consumed = true;
	}

	/** Remaining validity, for status display. */
	status(now = Date.now()): { active: boolean; expiresAt?: number } {
		const session = this.activeSession(now);
		return session ? { active: true, expiresAt: session.expiresAt } : { active: false };
	}
}
