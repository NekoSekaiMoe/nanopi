/**
 * pi-hostname — show the machine name in the footer status line.
 *
 * `0-` sorts the entry ahead of letter-keyed statuses. The hostname is reduced
 * to its first DNS label so a long FQDN does not eat the footer.
 */

import os from "node:os";
import type { ModuleEventsSurface } from "../../../core/modules/types.ts";

const STATUS_KEY = "0-hostname";

export function formatHostname(raw: string): string {
	return raw.replace(/\.$/, "").split(".")[0] ?? raw;
}

export default function hostname(pi: ModuleEventsSurface): void {
	pi.on("session_start", async (_event, ctx) => {
		const label = formatHostname(os.hostname());
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", label));
	});
}

export { STATUS_KEY };
