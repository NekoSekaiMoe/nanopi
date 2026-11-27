import os from "node:os";

/** Reduce a hostname to its first DNS label, dropping a trailing dot. */
export function formatHostname(raw: string): string {
	return raw.replace(/\.$/, "").split(".")[0] ?? raw;
}

/** Current machine hostname, reduced to its first DNS label. */
export function getHostname(): string {
	return formatHostname(os.hostname());
}
