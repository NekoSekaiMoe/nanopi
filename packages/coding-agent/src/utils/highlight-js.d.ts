// highlight.js 11 ships its own types and an export map that only knows the
// extensionless subpaths: `./lib/languages/*` maps to `./lib/languages/*.js`, so
// `highlight.js/lib/languages/bash.js` names a file that does not exist. Every
// specifier in this repo is written the way that map expects, which the package's
// own types do not describe, so route them at the real declarations: the module
// file for the subpath packages, the package root for the wildcard.
declare module "highlight.js/lib/core" {
	import hljs from "highlight.js";
	export default hljs;
}

declare module "highlight.js/lib/common" {
	import hljs from "highlight.js";
	export default hljs;
}

declare module "highlight.js/lib/languages/*" {
	import type { LanguageFn } from "highlight.js";

	const language: LanguageFn;
	export default language;
}
