import { createRequire } from "node:module";
import { getNativeModuleCandidates, getNativeModulePath } from "./native-module-path.ts";

const cjsRequire = createRequire(import.meta.url);

export type ModifierKey = "shift" | "command" | "control" | "option";

export interface NativeClipboard {
	/** Undefined means unavailable, null means no text; transfer failures reject. */
	getText(): Promise<string | null | undefined>;
	/** Undefined means unavailable, null means no image; transfer failures reject. */
	getImage(): Promise<Uint8Array | null | undefined>;
	/** POSIX paths of file URLs on the clipboard. Undefined means unsupported, null means no files. */
	getFilePaths?(): Promise<string[] | null | undefined>;
	/** Linux uses command-line tools to retain clipboard ownership instead. */
	setText?(text: string): Promise<void>;
}

type NativePlatformHelper = NativeClipboard & {
	enableVirtualTerminalInput?: () => boolean;
	isModifierPressed?: (name: ModifierKey) => boolean;
};

// Cache module loading, not display availability: a disconnected display can recover.
const helpers = new Map<string, NativePlatformHelper | undefined>();

function loadNativePlatformHelper(platform: string): NativePlatformHelper | undefined {
	const arch = process.arch;
	if (arch !== "x64" && arch !== "arm64") return undefined;
	const nativePath = getNativeModulePath(platform, arch);
	if (helpers.has(nativePath)) return helpers.get(nativePath);

	for (const modulePath of getNativeModuleCandidates(nativePath)) {
		try {
			const helper = cjsRequire(modulePath) as Partial<NativePlatformHelper> | null;
			if (typeof helper?.getText === "function" && typeof helper.getImage === "function") {
				helpers.set(nativePath, helper as NativePlatformHelper);
				return helper as NativePlatformHelper;
			}
		} catch {
			// Try the next possible packaging location.
		}
	}
	// Single-file distributions may finish downloading the native sidecar
	// after the first lookup; keep those paths retryable instead of caching
	// the miss for the whole process.
	if (!process.env.NANOPI_TUI_NATIVE_ROOT) {
		helpers.set(nativePath, undefined);
	}
	return undefined;
}

export function getNativePlatformHelper(): NativePlatformHelper | undefined {
	if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
	return loadNativePlatformHelper(process.platform);
}

/**
 * Load a clipboard helper without opening the display until a read is requested.
 * The Linux prebuild is the X11 unit; Wayland reads keep using `wl-paste`.
 */
export function getNativeClipboard(): NativeClipboard | undefined {
	if (process.platform !== "linux") return getNativePlatformHelper();
	if (!process.env.DISPLAY) return undefined;
	return loadNativePlatformHelper("linux");
}
