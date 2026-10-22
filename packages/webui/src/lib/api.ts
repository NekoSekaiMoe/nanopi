// HTTP client for nanopi's local webui daemon. This is a trimmed port of the
// previous Preact webui API client (MIT) so the Next.js UI keeps the same wire
// contract.

const SESSION_KEY = "nanopi.webuiToken";

function readToken(): string {
	try {
		const params = new URLSearchParams(location.search);
		const fromUrl = params.get("token");
		if (fromUrl) {
			try {
				sessionStorage.setItem(SESSION_KEY, fromUrl);
			} catch {
				/* storage unavailable */
			}
			try {
				params.delete("token");
				const query = params.toString();
				window.history.replaceState(
					null,
					"",
					location.pathname + (query ? `?${query}` : "") + location.hash,
				);
			} catch {
				/* no history API */
			}
			return fromUrl;
		}
		return sessionStorage.getItem(SESSION_KEY) ?? "";
	} catch {
		return "";
	}
}

const token = typeof window === "undefined" ? "" : readToken();

export function getToken(): string {
	return token;
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "X-nanopi-Client": "webui" };
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

async function readJson<T>(response: Response): Promise<T> {
	if (!response.ok) throw await failure(response);
	return response.json() as Promise<T>;
}

export async function failure(response: Response): Promise<ApiError> {
	const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
	const text = await response.text().catch(() => "");
	let message = "";
	let code: string | undefined;
	try {
		const body: unknown = JSON.parse(text);
		if (typeof body === "string") {
			message = body;
		} else if (body && typeof body === "object") {
			const error = body as { error?: unknown; code?: unknown };
			if (typeof error.error === "string") message = error.error;
			if (typeof error.code === "string") code = error.code;
		}
	} catch {
		if (text && !/^\s*</.test(text)) message = text.trim().slice(0, 500);
	}
	return new ApiError(message || `${status} ${response.url}`, response.status, code);
}

export interface ImageData {
	media_type: string;
	data: string;
}

export interface ModelInfo {
	provider: string;
	model: string;
	provider_type: string;
	is_default: boolean;
	effort_applicable: boolean;
	reasoning_effort: string | null;
	effort_levels: string[];
	/** False for a catalog model whose provider has no credential, so it cannot run. */
	available: boolean;
}

export async function getModels(): Promise<ModelInfo[]> {
	const response = await fetch("/models", { headers: authHeaders() });
	const body = await readJson<unknown>(response);
	if (!Array.isArray(body)) throw new Error("list models returned an invalid payload");
	return body as ModelInfo[];
}

export interface ProjectInfo {
	hash: string;
	name: string;
	working_dir: string;
	description?: string;
	session_count: number;
	created_at: number;
	last_updated: number;
}

export async function getProjects(): Promise<ProjectInfo[]> {
	const response = await fetch("/projects", { headers: authHeaders() });
	if (!response.ok) throw new Error(`list projects failed: ${response.status}`);
	const body: unknown = await response.json();
	if (!Array.isArray(body)) throw new Error("list projects returned an invalid payload");
	return body as ProjectInfo[];
}

export interface ProjectState {
	working_dir: string;
	previous_dir?: string;
	recent_dirs?: string[];
	name?: string;
	project_hash?: string;
}

export async function getProject(): Promise<ProjectState> {
	const response = await fetch("/project", { headers: authHeaders() });
	return readJson<ProjectState>(response);
}

export interface SessionMeta {
	id: string;
	name: string;
	working_dir: string;
	created_at: number;
	updated_at: number;
	message_count: number;
	file_size?: number;
}

export interface SessionMetaWithProject extends SessionMeta {
	project_hash: string;
}

export interface ToolCallInfo {
	id: string;
	name: string;
	arguments: string;
	display: string;
}

export interface ToolResultInfo {
	call_id: string;
	success: boolean;
	summary: string;
	line_count: number;
}

export interface SessionMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/** `provider/model` that produced an assistant reply. */
	provider?: string;
	synthetic?: boolean;
	internal_origin?: string;
	internalOrigin?: string;
	tool_calls?: ToolCallInfo[];
	tool_result?: ToolResultInfo;
	artifacts?: unknown;
	images?: ImageData[];
	created_at?: number;
}

export interface SessionDetail {
	id: string;
	name: string;
	working_dir: string;
	created_at: number;
	updated_at: number;
	message_count: number;
	/** Thinking level recorded in the transcript; resumes with the session. */
	thinking_level?: string;
	messages: SessionMessage[];
	/**
	 * Plan of the last `todo` result in the transcript. Absent for a session
	 * that never built one; present but empty after a `clear`.
	 */
	plan?: PlanItem[];
}

export async function listSessions(): Promise<SessionMetaWithProject[]> {
	const response = await fetch("/sessions", { headers: authHeaders() });
	return readJson<SessionMetaWithProject[]>(response);
}

export async function listProjectSessions(projectHash: string): Promise<SessionMetaWithProject[]> {
	const response = await fetch(`/projects/${encodeURIComponent(projectHash)}/sessions`, {
		headers: authHeaders(),
	});
	if (!response.ok) throw new Error(`list project sessions failed: ${response.status}`);
	const list = (await response.json()) as SessionMeta[];
	return list.map((meta) => ({ ...meta, project_hash: projectHash }));
}

export async function renameSession(
	projectHash: string,
	sessionId: string,
	name: string,
): Promise<void> {
	const response = await fetch(
		`/projects/${encodeURIComponent(projectHash)}/sessions/${encodeURIComponent(sessionId)}/rename`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json", ...authHeaders() },
			body: JSON.stringify({ name }),
		},
	);
	if (!response.ok) throw await failure(response);
}

export async function deleteSession(projectHash: string, sessionId: string): Promise<void> {
	const response = await fetch(
		`/projects/${encodeURIComponent(projectHash)}/sessions/${encodeURIComponent(sessionId)}`,
		{ method: "DELETE", headers: authHeaders() },
	);
	if (!response.ok) throw await failure(response);
}

export interface ChangeDirResult {
	success: boolean;
	message: string;
	current_dir: string;
	project_hash: string;
}

export async function changeDir(path: string, setDefault = false): Promise<ChangeDirResult> {
	const response = await fetch("/cd", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ path, set_default: setDefault }),
	});
	return readJson<ChangeDirResult>(response);
}

export async function getSession(projectHash: string, sessionId: string): Promise<SessionDetail> {
	const response = await fetch(
		`/projects/${encodeURIComponent(projectHash)}/sessions/${encodeURIComponent(sessionId)}`,
		{ headers: authHeaders() },
	);
	if (!response.ok) throw new Error(`get session failed: ${response.status}`);
	return response.json() as Promise<SessionDetail>;
}

export interface CreateSessionResponse {
	id: string;
	name: string;
	working_dir: string;
	project_hash: string;
	created_at: number;
}

export async function createSession(workingDir?: string, title?: string): Promise<CreateSessionResponse> {
	const body: Record<string, string> = {};
	if (workingDir) body.working_dir = workingDir;
	if (title) body.title = title;
	const response = await fetch("/sessions", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`create session failed: ${response.status}`);
	return response.json() as Promise<CreateSessionResponse>;
}

export async function resolveSession(id: string): Promise<SessionMetaWithProject | null> {
	const response = await fetch(`/sessions/resolve/${encodeURIComponent(id)}`, {
		headers: authHeaders(),
	});
	if (response.status === 404) return null;
	if (!response.ok) throw await failure(response);
	return response.json() as Promise<SessionMetaWithProject>;
}

export type ApprovalMode = "plan" | "minimal" | "standard";

export interface TurnStats {
	duration_ms: number;
	rounds: number;
	tool_calls: number;
	prompt_tokens: number;
	completion_tokens: number;
	cached_tokens: number;
}

export interface UserInputQuestion {
	header: string;
	question: string;
	mode: "single" | "multiple" | "text";
	options: { label: string; description?: string }[];
	custom?: boolean;
}

export interface UserInputResponseBody {
	declined: boolean;
	selected: string[];
	text: string | null;
}

export interface UserInputRequestEvent {
	type: "user_input_request";
	request_id: number;
	session_id?: string;
	header: string;
	question: string;
	mode: "single" | "multiple" | "text";
	options: { label: string; description?: string }[];
	questions?: UserInputQuestion[];
	custom?: boolean;
}

export interface ReasoningEffortResponse {
	provider: string;
	reasoning_effort: string;
}

export async function setReasoningEffort(
	provider: string,
	effort: string | null,
): Promise<ReasoningEffortResponse> {
	const response = await fetch("/models/reasoning-effort", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ provider, reasoning_effort: effort }),
	});
	return readJson<ReasoningEffortResponse>(response);
}

/** One step of the session plan the `todo` tool maintains. */
export interface PlanItem {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
	/** Verification steps must finish, so they never count as cancelled. */
	isVerification?: boolean;
}

export type SSEEvent =
	| { type: "runtime_info"; provider: string; model: string }
	| { type: "session_assigned"; session_id: string }
	| { type: "text"; content: string }
	| { type: "reasoning"; content: string }
	| { type: "tool_start"; id: string; name: string; arguments: unknown }
	| { type: "tool_output"; chunk: string }
	| { type: "tool_progress"; id: string; progress: string }
	| {
			type: "tool_result";
			id: string;
			name: string;
			output: string;
			success: boolean;
			duration_ms: number;
			/** Current plan, sent with every `todo` result; absent for other tools. */
			plan?: PlanItem[];
	  }
	| { type: "tokens"; prompt: number; completion: number; total: number }
	| {
			type: "permission_request";
			session_id: string;
			tool_name: string;
			reason: string;
			call_id: string;
			arguments: unknown;
			allow_all_bash?: boolean;
	  }
	| UserInputRequestEvent
	| {
			type: "done";
			tokens: unknown;
			tool_calls: unknown;
			session_id: string;
			stats?: TurnStats;
			stop_reason?: string;
			message?: string;
			code?: number;
	  }
	| { type: "stopped" }
	| { type: "error"; message: string; code?: number; retrying?: boolean }
	| { type: "retry"; attempt: number; max_attempts: number; delay_ms: number; message: string }
	| { type: "warning"; message: string }
	| { type: "persistence_warning"; message: string }
	| { type: "rate_limited"; message?: string }
	| { type: "artifact_start"; id: string; artifact_type: string; language?: string | null; title?: string | null }
	| { type: "artifact_content"; id: string; content: string }
	| { type: "artifact_end"; id: string }
	| { type: "command_output"; text: string };

export interface StreamChatBody {
	message: string;
	session_id?: string;
	request_id?: string;
	working_dir?: string;
	provider?: string;
	images?: ImageData[];
	approval_mode?: ApprovalMode;
}

export async function stopChat(sessionId: string): Promise<void> {
	const response = await fetch("/chat/stop", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ session_id: sessionId }),
	});
	if (!response.ok) throw new Error(`stop chat failed: ${response.status}`);
}

export async function streamChat(
	body: StreamChatBody,
	onEvent: (event: SSEEvent) => void,
	signal?: AbortSignal,
): Promise<void> {
	const response = await fetch("/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) throw await failure(response);

	const reader = response.body?.getReader();
	if (!reader) throw new Error("chat response has no body");
	const decoder = new TextDecoder();
	let buffer = "";
	let terminal = false;

	const emit = (event: SSEEvent) => {
		if (event.type === "done" || event.type === "stopped" || event.type === "error") terminal = true;
		onEvent(event);
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const parts = buffer.split("\n\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			const dataLine = part.split("\n").find((line) => line.startsWith("data:"));
			if (!dataLine) continue;
			const json = dataLine.slice("data:".length).trim();
			if (!json) continue;
			try {
				emit(JSON.parse(json) as SSEEvent);
			} catch {
				/* keepalive or partial line */
			}
		}
	}

	if (buffer.trim()) {
		const dataLine = buffer.split("\n").find((line) => line.startsWith("data:"));
		const json = dataLine?.slice("data:".length).trim();
		if (json) {
			try {
				emit(JSON.parse(json) as SSEEvent);
			} catch {
				/* ignore */
			}
		}
	}

	if (signal?.aborted) {
		const error = new Error("chat stream aborted");
		error.name = "AbortError";
		throw error;
	}
	if (!terminal) throw new Error("chat stream ended before a terminal event");
}

export async function respondPermission(
	sessionId: string,
	decision: "allow" | "deny" | "allow_session" | "ai_decide",
	toolName?: string,
	callId?: string,
): Promise<{ success: boolean }> {
	const response = await fetch("/chat/permission", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ session_id: sessionId, decision, tool_name: toolName, call_id: callId }),
	});
	return readJson<{ success: boolean }>(response);
}

export type UserInputResponse =
	| UserInputResponseBody
	| { responses: UserInputResponseBody[] };

export type UserInputAnswer =
	| ({ request_id: number } & UserInputResponseBody)
	| { request_id: number; responses: UserInputResponseBody[] };

export async function postChatUserInput(
	sessionId: string,
	answer: UserInputAnswer,
): Promise<{ accepted: boolean }> {
	const response = await fetch("/chat/user-input", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ session_id: sessionId, ...answer }),
	});
	if (!response.ok) throw new Error(`answer user input failed: ${response.status}`);
	const result = (await response.json()) as { accepted: boolean; error?: string };
	if (!result.accepted) throw new Error(result.error ?? "chat runtime did not accept the answer");
	return result;
}

export interface McpServerInfo {
	name: string;
	status: string;
	tool_count?: number;
	error?: string;
}

export interface McpStatusInfo {
	servers: McpServerInfo[];
	trusted?: boolean;
	blocked?: string[];
}

export async function getMcpStatus(): Promise<McpStatusInfo> {
	const response = await fetch("/mcp/status", { headers: authHeaders() });
	return readJson<McpStatusInfo>(response);
}

export interface SkillInfo {
	name: string;
	description: string;
}

export async function getSkills(): Promise<SkillInfo[]> {
	const response = await fetch("/skills", { headers: authHeaders() });
	return readJson<SkillInfo[]>(response);
}

export interface FsListResult {
	path: string;
	dirs: string[];
	files?: string[];
}

export async function listDir(path: string): Promise<FsListResult> {
	const response = await fetch(`/fs/list?path=${encodeURIComponent(path)}`, {
		headers: authHeaders(),
	});
	return readJson<FsListResult>(response);
}

export interface FileContent {
	path: string;
	size: number;
	binary: boolean;
	content: string;
	truncated: boolean;
}

export async function readFile(path: string): Promise<FileContent> {
	const response = await fetch(`/fs/read?path=${encodeURIComponent(path)}`, {
		headers: authHeaders(),
	});
	return readJson<FileContent>(response);
}

/** Current git branch for a directory, or "" outside a repository. */
export async function readBranch(path: string): Promise<string> {
	try {
		const content = await readFile(`${path}/.git/HEAD`);
		const line = content.content.trim();
		const prefix = "ref: refs/heads/";
		return line.startsWith(prefix) ? line.slice(prefix.length) : line.slice(0, 7);
	} catch {
		return "";
	}
}

export async function writeFile(path: string, content: string): Promise<{ path: string; size: number }> {
	const response = await fetch("/fs/write", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ path, content }),
	});
	return readJson<{ path: string; size: number }>(response);
}

export interface ProviderInfo {
	name: string;
	type: string;
	provider: string;
	model: string;
	base_url?: string;
	has_api_key?: boolean;
	is_default?: boolean;
}

export interface ProviderAccountInfo {
	id: string;
	provider: string;
	display_name?: string;
	type: string;
	base_url?: string;
	has_api_key: boolean;
	model_ids: string[];
	legacy: boolean;
	managed: boolean;
	label?: string;
	preset_name?: string;
	custom?: boolean;
	discoverable?: boolean;
	probeable?: boolean;
}

export interface ProviderPresetInfo {
	id: string;
	display_name: string;
	type: string;
	default_base_url?: string;
	requires_api_key: boolean;
	discoverable?: boolean;
}

export interface ConfigInfo {
	path: string;
	default_provider: string;
	default_workdir?: string;
	providers: ProviderInfo[];
	provider_accounts?: ProviderAccountInfo[];
	provider_presets?: ProviderPresetInfo[];
	provider_protocols?: ProviderPresetInfo[];
	reasoning_effort_levels?: string[];
	/** Patterns from the CLI's `enabledModels` setting; empty means every model is offered. */
	enabled_models?: string[];
}

export async function getConfig(): Promise<ConfigInfo> {
	const response = await fetch("/config", { headers: authHeaders() });
	return readJson<ConfigInfo>(response);
}

export interface NewModelBody {
	model: string;
	display_name?: string;
	context_window?: number;
	max_tokens?: number;
	supports_vision?: boolean;
	reasoning_effort?: string;
}

export interface CreateAccountBody {
	id?: string;
	provider: string;
	display_name?: string;
	base_url?: string;
	api_key?: string;
	models: NewModelBody[];
}

export interface AccountMutationResult {
	account?: string;
	models?: string[];
	config: ConfigInfo;
}

export async function createAccount(body: CreateAccountBody): Promise<AccountMutationResult> {
	const response = await fetch("/provider-accounts", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify(body),
	});
	return readJson<AccountMutationResult>(response);
}

export async function editAccount(
	id: string,
	body: { display_name?: string; base_url?: string; api_key?: string },
): Promise<{ config: ConfigInfo }> {
	const response = await fetch(`/provider-accounts/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify(body),
	});
	return readJson<{ config: ConfigInfo }>(response);
}

export async function deleteAccount(id: string): Promise<{ config: ConfigInfo }> {
	const response = await fetch(`/provider-accounts/${encodeURIComponent(id)}`, {
		method: "DELETE",
		headers: authHeaders(),
	});
	return readJson<{ config: ConfigInfo }>(response);
}

export async function addAccountModels(
	id: string,
	models: NewModelBody[],
): Promise<{ created: string[]; config: ConfigInfo }> {
	const response = await fetch(`/provider-accounts/${encodeURIComponent(id)}/models`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ models }),
	});
	return readJson<{ created: string[]; config: ConfigInfo }>(response);
}

export async function editAccountModel(
	id: string,
	modelId: string,
	body: { reasoning_effort?: string; clear_reasoning_effort?: boolean },
): Promise<{ config: ConfigInfo }> {
	const response = await fetch(
		`/provider-accounts/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json", ...authHeaders() },
			body: JSON.stringify(body),
		},
	);
	return readJson<{ config: ConfigInfo }>(response);
}

export async function deleteAccountModel(id: string, modelId: string): Promise<{ config: ConfigInfo }> {
	const response = await fetch(
		`/provider-accounts/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`,
		{ method: "DELETE", headers: authHeaders() },
	);
	return readJson<{ config: ConfigInfo }>(response);
}

export interface DiscoveredModelInfo {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
}

export async function discoverProviderModels(body: {
	type: string;
	base_url: string;
	api_key?: string;
}): Promise<DiscoveredModelInfo[]> {
	const response = await fetch("/providers/discover-models", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify(body),
	});
	const payload = await readJson<{ models: DiscoveredModelInfo[] }>(response);
	return payload.models;
}
