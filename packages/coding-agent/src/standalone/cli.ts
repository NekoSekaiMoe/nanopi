#!/usr/bin/env node
/**
 * Entry point for the single-file distribution built by
 * scripts/build-coding-agent-single-file.mjs.
 *
 * Import order is the contract: assets.ts extracts the embedded package
 * assets and sets NANOPI_PACKAGE_DIR before anything imports config.ts;
 * runtime-setup.ts registers the variable-specifier lazy modules the bundle
 * cannot resolve; then the normal CLI entrypoint runs.
 */
import "./assets.ts";
import "./runtime-setup.ts";
import { ensureSidecars, type SidecarStatus } from "../utils/sidecars.ts";
import "../cli.ts";

function reportSidecarStatus(status: SidecarStatus): void {
	if (status.type === "warning") {
		process.stderr.write(`nanopi: ${status.message}\n`);
	}
}

// Prefetch sidecars (photon wasm, TUI native prebuilds) in the background;
// photon also awaits its sidecar on demand before the first image read.
void ensureSidecars({ onStatus: reportSidecarStatus }).catch(() => undefined);
