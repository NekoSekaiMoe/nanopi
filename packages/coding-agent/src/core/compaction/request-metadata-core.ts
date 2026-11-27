import type { StreamFn } from "@nanopi/pi-agent-core";

/**
 * A time-ordered id for one compaction attempt. This module is imported by every summarizer, so
 * it cannot reach `@nanopi/pi-ai` for `uuidv7`; the ids never leave the request metadata.
 */
function uuidv7(): string {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const timestamp = Date.now();
	for (let index = 5; index >= 0; index--) bytes[index] = Number(BigInt(timestamp) >> BigInt((5 - index) * 8)) & 0xff;
	bytes[6] = 0x70 | (bytes[6] & 0x0f);
	bytes[8] = 0x80 | (bytes[8] & 0x3f);
	return [...bytes]
		.map((byte, index) => {
			const hex = byte.toString(16).padStart(2, "0");
			return index === 4 || index === 6 || index === 8 || index === 10 ? `-${hex}` : hex;
		})
		.join("");
}

export const REQUEST_IDENTITY_METADATA_KEY = "nanopi.requestIdentity";

export interface InternalRequestIdentity {
	sessionId: string;
	threadId: string;
	turnId: string;
	requestKind: "turn" | "compaction";
	startedAt: number;
	windowId?: string;
	windowNumber?: number;
	contextWindowId?: string;
}

export function getRequestIdentityMetadata(
	metadata: Record<string, unknown> | undefined,
): InternalRequestIdentity | undefined {
	const value = metadata?.[REQUEST_IDENTITY_METADATA_KEY];
	if (!value || typeof value !== "object") return undefined;
	return value as InternalRequestIdentity;
}

export function setRequestIdentityMetadata(
	metadata: Record<string, unknown> | undefined,
	identity: InternalRequestIdentity,
): Record<string, unknown> {
	return { ...metadata, [REQUEST_IDENTITY_METADATA_KEY]: identity };
}

/**
 * Wrap a caller-supplied stream function so the request carries compaction identity. There is no
 * default: the fallback for a caller without one is `completeSimple`, and reaching it from here
 * would make every reader of this module pay for the provider registry.
 */
export function withCompactionRequestMetadata(streamFn: StreamFn): StreamFn {
	const sessionId = uuidv7();
	const identity = {
		sessionId,
		threadId: sessionId,
		turnId: uuidv7(),
		requestKind: "compaction",
		startedAt: Date.now(),
	} satisfies InternalRequestIdentity;
	return (model, context, options) =>
		streamFn(model, context, {
			...options,
			metadata: setRequestIdentityMetadata(options?.metadata, identity),
		});
}
