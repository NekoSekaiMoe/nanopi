/**
 * Build-time component switches, resolved from buildconfig.json flavors by
 * the bundle and single-file build scripts and injected as an esbuild define
 * (see scripts/buildconfig.mjs). Outside bundled builds (source checkouts,
 * npm installs) the define is absent and every component is enabled.
 */
declare const NANOPI_BUILD_COMPONENTS: Record<string, boolean> | undefined;
declare const NANOPI_BUILD_TOOLSET: string | undefined;
declare const NANOPI_BUILD_PROVIDERS: string[] | undefined;

export function isBuildComponentEnabled(component: string): boolean {
	return typeof NANOPI_BUILD_COMPONENTS === "undefined" || NANOPI_BUILD_COMPONENTS[component] !== false;
}

/**
 * The `tools` component picks the built-in tool set: `bash` ships only the
 * shell tools, the default `standard` ships the full set. Values come from
 * `TOOLSET_COMPONENTS` in buildconfig.json, validated by scripts/buildconfig.mjs.
 */
export type Toolset = "standard" | "bash";

export function isBashOnlyBuild(): boolean {
	return typeof NANOPI_BUILD_TOOLSET !== "undefined" && NANOPI_BUILD_TOOLSET === "bash";
}

/**
 * Whether this build carries a provider's catalog. The `providers` component
 * picks a provider set from buildconfig.json, and the model generator only
 * writes the catalogs of that set, so a trimmed build has neither the data nor
 * the registration for the rest. The build scripts inject the resolved set; a
 * source checkout or npm install has no define and ships every provider.
 */
export function isProviderIncluded(providerId: string): boolean {
	if (typeof NANOPI_BUILD_PROVIDERS === "undefined") return true;
	return NANOPI_BUILD_PROVIDERS.includes(providerId);
}
