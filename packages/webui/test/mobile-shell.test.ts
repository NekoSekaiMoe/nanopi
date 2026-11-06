import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for shinytale/nanopi#554 (webui mobile adaptation, items 1-3).
// The soft-keyboard script is an inline head string (it must run before paint,
// so it has no module, no types, and no other automated coverage). Everything
// else here is a cross-file contract: the script writes --app-height, the CSS
// consumes it, and the shell/overlays opt in via h-app / overlay-fullscreen.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const layout = () => read("../src/app/layout.tsx");
const globals = () => read("../src/app/globals.css");
const component = (name: string) => read(`../src/components/${name}`);

/** Evaluate the injected script against fake window/document objects. */
function runHeightScript(opts: {
	coarse: boolean;
	vvHeight: number;
	innerHeight: number;
}) {
	const source = layout();
	const match = /const heightScript = `([\s\S]*?)`;/.exec(source);
	if (!match) throw new Error("heightScript not found in layout.tsx");

	const props: Record<string, string> = {};
	const classes = new Set<string>();
	const listeners: Record<string, () => void> = {};
	let attached = 0;

	const doc = {
		documentElement: {
			classList: {
				toggle: (name: string, force: boolean) => {
					if (force) classes.add(name);
					else classes.delete(name);
				},
			},
			style: { setProperty: (key: string, value: string) => { props[key] = value; } },
		},
	};
	const vv = {
		height: opts.vvHeight,
		addEventListener: (event: string, fn: () => void) => {
			attached += 1;
			listeners[event] = fn;
		},
	};
	const win = {
		visualViewport: vv,
		innerHeight: opts.innerHeight,
		matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" && opts.coarse }),
		addEventListener: (event: string, fn: () => void) => {
			attached += 1;
			listeners[`window:${event}`] = fn;
		},
	};

	new Function("window", "document", match[1])(win, doc);
	return { props, classes, listeners, vv, attached };
}

describe("soft-keyboard height script (issue #554)", () => {
	it("publishes --app-height on a touch device", () => {
		const env = runHeightScript({ coarse: true, vvHeight: 780, innerHeight: 780 });
		expect(env.props["--app-height"]).toBe("780px");
		expect(env.classes.has("keyboard-open")).toBe(false);
	});

	it("flags keyboard-open and shrinks --app-height when the viewport is covered", () => {
		const env = runHeightScript({ coarse: true, vvHeight: 460, innerHeight: 780 });
		expect(env.props["--app-height"]).toBe("460px");
		expect(env.classes.has("keyboard-open")).toBe(true);
	});

	it("re-applies on visualViewport resize", () => {
		const env = runHeightScript({ coarse: true, vvHeight: 780, innerHeight: 780 });
		env.vv.height = 420;
		env.listeners.resize();
		expect(env.props["--app-height"]).toBe("420px");
		expect(env.classes.has("keyboard-open")).toBe(true);
	});

	it("stays off on fine-pointer devices (desktop zoom must not shrink the shell)", () => {
		const env = runHeightScript({ coarse: false, vvHeight: 500, innerHeight: 780 });
		expect(env.props["--app-height"]).toBeUndefined();
		expect(env.classes.has("keyboard-open")).toBe(false);
		expect(env.attached).toBe(0);
	});
});

describe("cross-file wiring (issue #554)", () => {
	it("viewport opts into resizes-content", () => {
		expect(layout()).toContain('interactiveWidget: "resizes-content"');
	});

	it("CSS defines a --app-height-backed shell height and a keyboard overlay clamp", () => {
		const css = globals();
		expect(css).toMatch(/\.h-app\s*\{[^}]*var\(--app-height, ?100dvh\)/);
		expect(css).toContain(".keyboard-open .overlay-fullscreen");
		expect(css).toContain("@custom-variant can-hover (@media (hover: hover))");
	});

	it("shell and all full-bleed overlays opt into the height tracking", () => {
		expect(component("app-client.tsx")).toContain('"flex h-app w-screen');
		expect(component("app-client.tsx")).not.toContain("h-dvh w-screen");
		for (const file of ["app-client.tsx", "model-picker.tsx", "settings.tsx"]) {
			expect(component(file)).toContain("overlay-fullscreen");
		}
	});

	it("press and code-block hover states are gated to hover-capable devices", () => {
		const css = globals();
		for (const selector of [".press:hover::before", ".press-fill:hover::before", ".press-brand:hover::before", ".code-block-head button:hover"]) {
			const index = css.indexOf(selector);
			expect(index, selector).toBeGreaterThan(-1);
			expect(css.slice(Math.max(0, index - 60), index)).toContain("@media (hover: hover)");
		}
	});
});

describe("sidebar hover and touch targets (issue #554)", () => {
	it("gates the invisible-until-hover controls behind can-hover", () => {
		const sidebar = component("sidebar.tsx");
		expect(sidebar).toContain("can-hover:opacity-0");
		expect(sidebar).toContain("can-hover:group-hover:opacity-100");
		expect(sidebar).toContain("can-hover:group-focus-within:opacity-100");
		// The timestamp and "..." menu must remain visible on touch devices.
		expect(sidebar).toContain("opacity-100 can-hover:opacity-0");
	});

	it("bumps session rows and controls to >=44px on mobile", () => {
		const sidebar = component("sidebar.tsx");
		for (const cls of ["max-md:min-h-11", "max-md:h-11", "max-md:size-11"]) {
			expect(sidebar).toContain(cls);
		}
		for (const file of ["permission-card.tsx", "user-input-card.tsx", "model-picker.tsx"]) {
			expect(component(file)).toMatch(/max-md:(h-11|min-h-11)/);
		}
	});
});
