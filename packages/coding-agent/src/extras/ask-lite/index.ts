/**
 * rpiv-ask-user-question — Pi extension. Registers the `ask_user_question`
 * tool: a structured option selector with a free-text "Other" fallback.
 *
 * Sentinel labels and TUI chrome strings localize at render time via the i18n
 * bridge. Strings are registered with rpiv-i18n here, once, at module init —
 * but only when the SDK is actually installed. If `@juicesharp/rpiv-i18n` is
 * missing (standalone install of just this package), the dynamic-load shim
 * no-ops and the bridge's `t(key, fallback)` returns the inline English literal
 * at every call site. The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 */

import type { ModuleApi } from "@nanopi/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { I18N_NAMESPACE } from "./state/i18n-bridge.js";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

// Dynamic import keeps `@juicesharp/rpiv-i18n` a soft optional peer: when the
// SDK is installed alongside this package the strings register and
// `/languages` flips them live; when it isn't, the import rejects here, we
// no-op, and the bridge's English-fallback shim keeps the extension online.
//
// The `/loader` subpath is used instead of the SDK entry so the i18n-ui +
// pi-tui modules are not pulled into our load graph just to register strings.
//
// The import is fire-and-forget instead of top-level await: this module is
// compiled into the nanopi CLI bundle, whose launcher require()s the ESM
// graph synchronously (for the V8 compile cache), and require() rejects any
// graph containing top-level await. Registration is idempotent and
// render-time lookups fall back to English until it completes.
try {
	const i18nLoaderId = "@juicesharp/rpiv-i18n/loader";
	void import(i18nLoaderId)
		.then((sdk) => {
			(sdk as I18nLoader).registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, {
				label: "rpiv-ask-user-question",
			});
		})
		.catch(() => {
			// SDK absent — extension still loads with English-only UI.
		});
} catch {
	// Synchronous import() scheduling failure — same English-only outcome.
}

export {
	ASK_USER_PROMPT_EVENT,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "./events.js";

export default function (pi: ModuleApi) {
	registerAskUserQuestionTool(pi);
}
