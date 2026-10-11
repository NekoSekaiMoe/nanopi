import type { ProviderEnv } from "../types.ts";

/**
 * Resolve a provider env value from scoped overrides, then normal process.env.
 */
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return env?.[name] || (typeof process !== "undefined" ? process.env[name] : undefined) || undefined;
}
