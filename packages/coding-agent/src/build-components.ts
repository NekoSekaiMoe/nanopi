/**
 * Build-time component switches, resolved from buildconfig.json flavors by
 * the bundle and single-file build scripts and injected as an esbuild define
 * (see scripts/buildconfig.mjs). Outside bundled builds (source checkouts,
 * npm installs) the define is absent and every component is enabled.
 */
declare const NANOPI_BUILD_COMPONENTS: Record<string, boolean> | undefined;
declare const NANOPI_BUILD_TOOLSET: string | undefined;

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
