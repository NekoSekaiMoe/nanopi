/**
 * Build-time component switches, resolved from buildconfig.json flavors by
 * the bundle and single-file build scripts and injected as an esbuild define
 * (see scripts/buildconfig.mjs). Outside bundled builds (source checkouts,
 * npm installs) the define is absent and every component is enabled.
 */
declare const NANOPI_BUILD_COMPONENTS: Record<string, boolean> | undefined;
declare const NANOPI_BUILD_TOOLSET: string | undefined;
declare const NANOPI_BUILD_PROVIDERS: string[] | undefined;
declare const NANOPI_BUILD_APIS: string[] | undefined;
declare const NANOPI_BUILD_TOOLS: string[] | undefined;

/**
 * Whether a component is in this build. A component the resolved map does not
 * mention is enabled: the map lists what a build carries, and an older bundle
 * predates the component entirely. Reading the absence as "disabled" would turn
 * every added component into a silently dead feature.
 */
export function isBuildComponentEnabled(component: string): boolean {
	return typeof NANOPI_BUILD_COMPONENTS === "undefined" || NANOPI_BUILD_COMPONENTS[component] !== false;
}

/**
 * The `toolset` component picks the built-in tool set: `bash` ships only the
 * shell tools, the default `standard` ships the full set. Values come from
 * `toolsetComponents` in buildconfig.json, validated by scripts/buildconfig.mjs.
 */
export type Toolset = "standard" | "bash";

/** The tool set this build registers, or undefined outside bundled builds. */
export function buildToolset(): string | undefined {
	return typeof NANOPI_BUILD_TOOLSET === "undefined" ? undefined : NANOPI_BUILD_TOOLSET;
}

/**
 * Whether the build's tool set carries nothing but the shell tools.
 *
 * Read from the tool names, not from the set's name: a tool set is a list of
 * tools in buildconfig.json, and a third set that also names only shell tools
 * does not have to be spelled "bash" to get the shell-only prompt and the
 * bash-only guard.
 */
export function isBashOnlyBuild(): boolean {
	const names = builtinToolNames();
	return names?.every((name) => isShellToolName(name)) ?? false;
}

/**
 * Tool names that are shell tools: the tool set ships them on every platform
 * the build targets, and everything else (read, edit, write, grep, find, ls)
 * is a file tool whose absence changes the system prompt.
 */
const SHELL_TOOL_NAMES = ["bash", "powershell"];

export function isShellToolName(name: string): boolean {
	return SHELL_TOOL_NAMES.includes(name);
}

/**
 * The provider ids this build carries, or undefined when every provider is
 * built in. A flavor that names a provider set narrows the model generator to
 * that set (or to none, for the `__NONE__` marker), and the build scripts
 * inject the resolved list, so a trimmed build registers neither the catalog
 * nor the registration of the providers it drops. A source checkout or npm
 * install has no define and ships every provider.
 */
export function builtinProviderIds(): readonly string[] | undefined {
	// A full set arrives as the string "undefined", like builtinApiIds() above.
	if (typeof NANOPI_BUILD_PROVIDERS === "undefined" || (NANOPI_BUILD_PROVIDERS as unknown) === "undefined")
		return undefined;
	return NANOPI_BUILD_PROVIDERS;
}

/** Whether this build carries a provider's catalog. */
export function isProviderIncluded(providerId: string): boolean {
	const included = builtinProviderIds();
	return included === undefined || included.includes(providerId);
}

/**
 * Whether this build ships no built-in provider at all. Such a build takes its
 * endpoint and key from `models.json`, so its no-models guidance points there
 * instead of at `/login`.
 */
export function isNoBuiltinProviderBuild(): boolean {
	const included = builtinProviderIds();
	return included !== undefined && included.length === 0;
}

/**
 * The API ids this build registers, or undefined when it registers every
 * implementation. A flavor that names an API set ships no client for the APIs
 * it drops, so `models.json` can only reference the ids its set carries.
 */
export function builtinApiIds(): readonly string[] | undefined {
	// The define map spells a full set as the string "undefined" (esbuild rejects
	// an undefined define value), which reads the same as an absent define here.
	if (typeof NANOPI_BUILD_APIS === "undefined" || (NANOPI_BUILD_APIS as unknown) === "undefined") return undefined;
	return NANOPI_BUILD_APIS;
}

/** Whether this build registers a provider API implementation. */
export function isApiIncluded(api: string): boolean {
	const included = builtinApiIds();
	return included === undefined || included.includes("__ALL__") || included.includes(api);
}

/** Human-readable list of the API ids this build carries, for error messages. */
export function formatIncludedApis(): string {
	const included = builtinApiIds();
	return included === undefined || included.includes("__ALL__") ? "every built-in API" : included.join(", ");
}

/**
 * The built-in tool names this build's tool set ships, or undefined for a
 * build that keeps every tool. The bundle stubs out the definitions a tool set
 * leaves out (`scripts/build-tools.mjs`), so the names double as the list the
 * session may activate.
 */
export function builtinToolNames(): readonly string[] | undefined {
	const included = typeof NANOPI_BUILD_TOOLS === "undefined" ? undefined : NANOPI_BUILD_TOOLS;
	return included === undefined || included.length === 0 ? undefined : included;
}

/**
 * OAuth login flows this build carries, by flow id (buildconfig.json
 * `oauth/<flow>` components). The flow ids match `scripts/oauth-flows.mjs`
 * and the `importOAuthModule` calls in `@nanopi/pi-ai`'s `auth/oauth/load.ts`;
 * `validateOAuthFlowRegistry()` keeps the three in lockstep at build time.
 */
export const OAUTH_FLOW_IDS: readonly string[] = [
	"anthropic",
	"antigravity",
	"github-copilot",
	"kimi-coding",
	"meta",
	"openai-chatgpt",
	"openai-codex",
	"openrouter",
	"xai",
];

/** Whether this build carries a single OAuth flow. */
export function isOAuthFlowEnabled(flow: string): boolean {
	return isBuildComponentEnabled(`oauth/${flow}`);
}

/** OAuth flows this build carries, in registry order. Empty means the build logs in with API keys only. */
export function enabledOAuthFlows(): readonly string[] {
	return OAUTH_FLOW_IDS.filter((flow) => isOAuthFlowEnabled(flow));
}

/**
 * Whether this build ships any OAuth login flow at all. Any enabled flow is
 * enough: the flag describes the build, not one provider, so a build carrying
 * only `oauth/github-copilot` still shows the OAuth entry points.
 */
export function hasOAuthFlows(): boolean {
	return enabledOAuthFlows().length > 0;
}
