import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** `NANOPI_TELEMETRY` overrides the stored `enableInstallTelemetry` setting when set. */
function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.NANOPI_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}

/**
 * Whether outgoing requests may identify this installation: the provider attribution headers and
 * OpenCode's routing identity. Both answer the same question, so they share one gate instead of
 * each reading its own setting. Analytics consent counts as approval for the same reason.
 */
export function isProviderAttributionEnabled(settingsManager: SettingsManager): boolean {
	return isInstallTelemetryEnabled(settingsManager) || settingsManager.getEnableAnalytics();
}
