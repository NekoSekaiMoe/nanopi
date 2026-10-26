/**
 * Diagnostic bundles for `NANOPI_DEBUG=1`.
 *
 * Debug mode already appends `nanopi-debug.log` to the agent dir. The log says
 * what nanopi cost; it cannot say what broke. A crash mid-session or a report
 * that ends up in an issue needs the environment, the provider errors, and the
 * transcript, and asking the user to assemble those by hand loses them at the
 * moment they are needed most.
 *
 * So one flag governs both: when `NANOPI_DEBUG` is on, interactive mode writes
 * `<agent dir>/diagnostics/` — a bundle at startup and another at exit. Both are
 * written without a prompt, because nobody knows they needed the bundle until
 * after the failure, and a debug run that requires consent at shutdown produces
 * an empty directory exactly then.
 *
 * A bundle is a zip beside the loose files it was built from, so the transcript
 * can be read without unzipping. Secrets are the one thing that is not written:
 * every URL, header value, and settings field that looks like a credential is
 * redacted before it reaches the disk.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@nanopi/pi-agent-core";
import type { Api, Model } from "@nanopi/pi-ai/compat";
import { APP_NAME, getAgentDir, getDebugLogPath, VERSION } from "../config.ts";
import { getNanoPiUserAgent } from "../utils/nanopi-user-agent.ts";
import { writeZipArchive } from "../utils/zip.ts";
import type { CrashRecord } from "./crash-log.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { LoadModulesResult } from "./modules/types.ts";
import type { ReadonlySessionManager } from "./session-manager.ts";
import type { Settings } from "./settings-manager.ts";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const DIAGNOSTICS_DIR_NAME = "diagnostics";
const REDACTED = "<redacted>";
const SENSITIVE_KEY =
	/(?:^|[-_])(api[-_]?key|apikey|secret|token|password|passwd|credential|credentials|authorization|cookie)(?:$|[-_])/i;

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

/** Strip credentials and secret-looking query parameters from a URL. */
export function redactUrl(value: string): string {
	const nested = /^([a-z][a-z0-9+.-]*:)([a-z][a-z0-9+.-]*:\/\/.*)$/i.exec(value);
	if (nested) return `${nested[1]}${redactUrl(nested[2])}`;
	try {
		const url = new URL(value);
		let changed = false;
		if (url.username || url.password) {
			url.username = "";
			url.password = "";
			changed = true;
		}
		for (const key of url.searchParams.keys()) {
			if (isSensitiveKey(key)) {
				url.searchParams.set(key, REDACTED);
				changed = true;
			}
		}
		return changed ? url.toString() : value;
	} catch {
		return value;
	}
}

/** Copy a JSON value while removing values that may contain credentials. */
export function redactJsonValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	return JSON.parse(
		JSON.stringify(value, (key, child: unknown) => {
			if (child !== null && child !== undefined && isSensitiveKey(key)) return REDACTED;
			return typeof child === "string" ? redactUrl(child) : child;
		}),
	);
}

function redactSettings(settings: Settings): Settings {
	// Tracking and device ids identify the installation, not the failure.
	const { trackingId: _trackingId, deviceId: _deviceId, ...rest } = settings;
	return redactJsonValue(rest) as Settings;
}

function collectEnvironment() {
	const env = (name: string): string | null => process.env[name] || null;
	return {
		version: VERSION,
		userAgent: getNanoPiUserAgent(VERSION),
		runtime: `node/${process.version}`,
		platform: process.platform,
		arch: process.arch,
		osRelease: os.release(),
		osVersion: os.version(),
		pid: process.pid,
		shell: process.env.SHELL?.split(/[\\/]/).pop() || null,
		debugLog: getDebugLogPath(),
		terminal: {
			term: env("TERM"),
			program: env("TERM_PROGRAM"),
			programVersion: env("TERM_PROGRAM_VERSION"),
			colorterm: env("COLORTERM"),
			tmux: Boolean(process.env.TMUX),
			ssh: Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY),
			ci: Boolean(process.env.CI),
		},
		// Names help diagnose configuration; values never leave the machine.
		nanopiEnvironmentVariables: Object.keys(process.env)
			.filter((name) => name.startsWith("NANOPI_"))
			.sort(),
	};
}

function describeModel(model: Model<Api>) {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: redactUrl(model.baseUrl),
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		samplingParams: model.samplingParams ? redactJsonValue(model.samplingParams) : null,
		compat: model.compat ? redactJsonValue(model.compat) : null,
		thinkingLevelMap: model.thinkingLevelMap ?? null,
		headerNames: Object.keys(model.headers ?? {}).sort(),
	};
}

function describeProvider(modelRuntime: ModelRuntime, providerId: string) {
	const provider = modelRuntime.getProvider(providerId);
	if (!provider) return null;
	const authTypes: Array<"api_key" | "oauth"> = [];
	if (provider.auth.apiKey) authTypes.push("api_key");
	if (provider.auth.oauth) authTypes.push("oauth");
	return {
		id: provider.id,
		name: provider.name,
		baseUrl: provider.baseUrl ? redactUrl(provider.baseUrl) : null,
		headerNames: Object.keys(provider.headers ?? {}).sort(),
		authTypes,
		authStatus: modelRuntime.getProviderAuthStatus(provider.id),
		usingOAuth: modelRuntime.isUsingOAuth(provider.id),
		registeredByExtension: modelRuntime.getRegisteredProviderIds().includes(provider.id),
	};
}

function describeExtension(module: LoadModulesResult["modules"][number]) {
	return {
		path: module.name,
		source: redactUrl(module.sourceInfo.source),
		scope: module.sourceInfo.scope,
		origin: module.sourceInfo.origin,
		hidden: module.hidden === true,
	};
}

export interface DiagnosticBundleInput {
	/** `startup` or `exit`; only labels where in the session lifetime the bundle was taken. */
	phase: "startup" | "exit";
	cwd: string;
	sessionManager: ReadonlySessionManager;
	model?: Model<Api>;
	modelRuntime: ModelRuntime;
	thinkingLevel: ThinkingLevel;
	modules: LoadModulesResult;
	settings: { global: Settings; project: Settings };
	crashes: readonly CrashRecord[];
	/** Session branch as JSONL; absent when the session is not persistent. */
	sessionJsonl?: string;
	/** Agent dir the loose files are written to; defaults to `getAgentDir()`. */
	agentDir?: string;
}

export function buildDiagnosticMetadata(input: DiagnosticBundleInput) {
	const createdAt = new Date().toISOString();
	const providerId = input.model?.provider;
	return {
		schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
		kind: `${APP_NAME}.diagnostics`,
		phase: input.phase,
		createdAt,
		environment: collectEnvironment(),
		session: {
			id: input.sessionManager.getSessionId(),
			file: input.sessionManager.getSessionFile() ?? null,
			cwd: input.cwd,
			entryCount: input.sessionManager.getEntries().length,
			leafId: input.sessionManager.getLeafId(),
			transcriptIncluded: input.sessionJsonl !== undefined,
		},
		model: input.model ? describeModel(input.model) : null,
		provider: providerId ? describeProvider(input.modelRuntime, providerId) : null,
		thinkingLevel: input.thinkingLevel,
		modules: {
			loaded: input.modules.modules.map(describeExtension),
			errors: input.modules.errors.map(({ path, error }) => ({ path, error })),
			warnings: (input.modules.warnings ?? []).map(({ path, warning }) => ({ path, warning })),
		},
		settings: {
			global: redactSettings(input.settings.global),
			project: redactSettings(input.settings.project),
		},
	};
}

export type DiagnosticMetadata = ReturnType<typeof buildDiagnosticMetadata>;

/** Failed assistant turns, without collecting conversation content. */
export function buildDiagnosticReport(input: DiagnosticBundleInput) {
	const entries = input.sessionManager.getEntries();
	const assistant = [];
	let assistantMessageCount = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		assistantMessageCount++;
		const message = entry.message;
		const diagnostics = message.diagnostics ?? [];
		if (
			diagnostics.length === 0 &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			!message.errorMessage
		) {
			continue;
		}
		assistant.push({
			entryId: entry.id,
			timestamp: entry.timestamp,
			provider: message.provider,
			model: message.model,
			api: message.api,
			stopReason: message.stopReason,
			...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
			...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			diagnostics,
		});
	}
	return {
		schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
		kind: `${APP_NAME}.diagnostics-report`,
		phase: input.phase,
		sessionId: input.sessionManager.getSessionId(),
		entryCount: entries.length,
		assistantMessageCount,
		assistant,
		crashes: input.crashes.map(({ notified: _notified, ...record }) => record),
	};
}

export type DiagnosticReport = ReturnType<typeof buildDiagnosticReport>;

export interface DiagnosticBundleFile {
	name: string;
	contentType: string;
	data: string;
}

export function diagnosticBundleFiles(input: DiagnosticBundleInput): DiagnosticBundleFile[] {
	const files: DiagnosticBundleFile[] = [
		{
			name: "diagnostics.json",
			contentType: "application/json",
			data: `${JSON.stringify(buildDiagnosticMetadata(input), null, 2)}\n`,
		},
		{
			name: "report.json",
			contentType: "application/json",
			data: `${JSON.stringify(buildDiagnosticReport(input), null, 2)}\n`,
		},
	];
	if (input.sessionJsonl !== undefined) {
		files.push({ name: "session.jsonl", contentType: "application/x-ndjson", data: input.sessionJsonl });
	}
	const debugLog = readDebugLog();
	if (debugLog !== undefined) {
		files.push({ name: "debug.log", contentType: "text/plain", data: debugLog });
	}
	return files;
}

/** The debug log tail, so the archive carries the numbers the user pasted an issue about. */
function readDebugLog(path = getDebugLogPath(), maxBytes = 512 * 1024): string | undefined {
	try {
		const content = readFileSync(path);
		if (content.length <= maxBytes) return content.toString("utf8");
		return `<truncated to the last ${maxBytes} bytes>\n${content.subarray(content.length - maxBytes).toString("utf8")}`;
	} catch {
		return undefined;
	}
}

function fileTimestamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

export interface WrittenDiagnosticBundle {
	directory: string;
	archivePath?: string;
	files: string[];
}

/**
 * Write one bundle into `<agentDir>/diagnostics/<timestamp>-<phase>/`: the loose
 * files, then `bundle.zip` beside them. Every write is best-effort — debug
 * diagnostics must never be the reason a session fails to start or exit.
 */
export async function writeDiagnosticBundle(
	input: DiagnosticBundleInput,
): Promise<WrittenDiagnosticBundle | undefined> {
	const agentDir = input.agentDir ?? getAgentDir();
	const directory = join(agentDir, DIAGNOSTICS_DIR_NAME, `${fileTimestamp(new Date())}-${input.phase}`);
	try {
		const files = diagnosticBundleFiles(input);
		mkdirSync(directory, { recursive: true });
		for (const file of files) writeFileBestEffort(join(directory, file.name), file.data);
		const archivePath = join(directory, "bundle.zip");
		try {
			await writeZipArchive(
				archivePath,
				files.map(({ name, data }) => ({ name, data })),
			);
		} catch {
			return { directory, files: files.map((file) => file.name) };
		}
		return { directory, archivePath, files: files.map((file) => file.name) };
	} catch {
		return undefined;
	}
}

function writeFileBestEffort(path: string, data: string): void {
	try {
		writeFileSync(path, data);
	} catch {
		// The archive still carries the content, so a failed loose write is not fatal.
	}
}
