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
 * The provider ids this build carries, or undefined when every provider is
 * built in. A flavor that names a provider set narrows the model generator to
 * that set (or to none, for the `__NONE__` marker), and the build scripts
 * inject the resolved list, so a trimmed build registers neither the catalog
 * nor the registration of the providers it drops. A source checkout or npm
 * install has no define and ships every provider.
 */
export function builtinProviderIds(): readonly string[] | undefined {
	return typeof NANOPI_BUILD_PROVIDERS === "undefined" ? undefined : NANOPI_BUILD_PROVIDERS;
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
