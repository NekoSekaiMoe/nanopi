# Agent Note: Remove the theme system and the /reload command

Status: implemented

## Problem

The theme feature carried a full resource pipeline for what is, in this fork, a
cosmetic choice almost nobody makes: built-in `dark`/`light` JSON themes plus
user-authored theme JSONs discovered from `~/.nanopi/agent/themes` and
`.nanopi/themes`, layered through settings (`theme` selection with
`light/dark` automatic pairs, `themes` path array), CLI flags
(`--theme`/`--use-theme`/`--no-themes`), a JSON-schema artifact, a
ThemeSubmenu in `/settings`, a `ThemeSelectorComponent`, an FSWatcher that
hot-reloaded the active theme file, and theme registries threaded through
`ResourceLoader.getThemes()`, the module UI context (`getAllThemes`/`getTheme`/
`setTheme`), and `exportToHtml({ themeName })`.

Every renderer and component, meanwhile, only consumes one thing: the global
`theme` singleton (`Theme` instance) and its token colors. The rendering layer
and the user-facing selection/customization feature are separable, and the
feature side kept costing surface (settings schema, trust rules, startup
discovery, schema artifact, tests) for zero use in this fork.

User decision (2026-10-13): remove the theme feature entirely — nanopi always
uses the system theme generated from the terminal's own reported colors — and
remove the interactive `/reload` command with it (settings/keybinding/resource
changes now need a restart).

## Decision

The split line is *rendering stays, selection goes*.

### Kept (rendering foundation, `theme/theme.ts` + `theme-tokens.ts`)

- The `Theme` class (token→ANSI precomputation, `fg`/`bg`/`style`, concrete
  colors with terminal-default `""` tokens, faint/SGR-2 tokens,
  `getThinkingBorderColor`), the token schema, and the `theme` global
  (`globalThis` symbol proxy) + `getThemeInstance()` identity checks that
  renderers use for cache invalidation.
- Terminal color plumbing: `setTerminalColors`, `setTerminalColorScheme`,
  `markTerminalColorsPending`, `detectTerminalTheme`, `detectColorFgBgTheme`,
  `getTerminalTheme`.
- `initTheme()` (no arguments — always the system theme) and a new
  `refreshSystemTheme()` that regenerates the system theme from the colors
  reported so far and installs a new instance (callers then invalidate).
- TUI helpers other code renders with: `getMarkdownTheme`,
  `getSelectListTheme`, `getEditorTheme`, `getSettingsListTheme`,
  `highlightCode`, `getLanguageFromPath`, `getResolvedThemeColors()` (active
  instance; HTML export derives its page/card/info backgrounds from
  `userMessageBg` only).

### Removed (the feature)

- Built-in `dark.json`/`light.json`, custom theme discovery (resource
  discovery, `ResourceLoader.getThemes()`, `themesOverride`,
  `additionalThemePaths`, `noThemes`), theme diagnostics/collision type, and
  the `themes` entry in the trust-requiring project resources.
- Settings: `theme` and `themes` keys, `SettingsManager.getThemeSetting()/
  getTheme()/setTheme()/getThemePaths()/setProjectThemePaths()`.
- CLI: `--theme`, `--use-theme`, `--no-themes` (and the `noThemes` Args
  field). `/settings` Theme submenu and `ThemeSelectorComponent`;
  first-time setup is analytics-only.
- Theme JSON validation (`theme-schema.ts`, `setThemeJsonValidator`,
  `schemas/theme.schema.json` and its generator entry), the theme file
  watcher, `setRegisteredThemes`, `setTheme`/`setThemeInstance`/`onThemeChange`,
  `parseAutoThemeSetting`/`resolveThemeSetting`, `getAvailableThemes*`,
  `getThemeByName`, `loadThemeFromPath`, `getThemeExportColors`,
  `isLightTheme`; `getThemesDir()`/`getCustomThemesDir()` in config.ts; theme
  JSON copying in copy-assets and the single-file asset payload.
- Module UI context: `getAllThemes()`/`getTheme(name)`/`setTheme()` (the
  `theme` getter stays — modules render with it). `exportToHtml()` loses its
  `themeName` option and always exports with the active system theme.
- `/reload`: the slash-command registration, the interactive-mode dispatch,
  and `handleReloadCommand()`.

`InteractiveThemeController` shrank to terminal-color synchronization: install
the system theme (grayscale-pending), query terminal colors
(`requestTerminalColors`, unchanged), regenerate on arrival and on terminal
light/dark reports, `waitForTerminalColors()` for startup content that bakes
colors into strings, `dispose()` unsubscribes and turns scheme notifications
off. Startup TUIs (`startup-ui.ts`) use the same flow via
`initTheme` + `refreshSystemTheme`.

## Alternatives considered

- **Remove only custom-theme resources, keep system/dark/light selection**:
  rejected — `--use-theme` (selection) was already being stripped when this
  work started, and keeping three built-ins preserves the settings schema,
  submenu, and dual-theme automatic mode for a fork that wants terminal-derived
  colors anyway.
- **Delete the whole `Theme` class and token system, render with plain chalk**:
  rejected — every tool renderer, markdown/editor/select-list theme helper,
  syntax highlighting, and HTML export consumes token colors; the color system
  is the rendering contract, not the feature. Removing it rewrites ~50 render
  call sites for a worse result (no terminal-color derivation, no contrast
  rules).
- **Keep `/reload` minus themes** (it also refreshes keybindings, skills,
  prompts, context files): rejected by user decision — the runtime reload
  machinery stays for module-requested and models.json hot reloads, but the
  manual command goes; restart covers the manual case.

## Consequences

- Users who set `theme`/`themes` in settings.json keep unrecognized keys
  (schema allows additional properties); no migration needed.
- Terminals that report no colors get the tier-3 system theme (ANSI palette
  indices + faint tokens) — deterministic and readable, but visually different
  from the old fixed `dark` theme; tests that asserted exact escape sequences
  were rewritten to build expectations through the theme API instead of
  literals.
- Module authors lose runtime theme switching; in-memory `Theme` instances can
  no longer be installed (`setThemeInstance` gone). Anything needing custom
  colors should render through the token system or its own ANSI strings.
- ~10 test files deleted (theme picker/export/resource-loader/watcher), the
  controller/style/detection/system-theme suites rewritten against the
  system-only API; `settings.schema.json` regenerated (this also drops the
  stale `extensionChangelogVersions` left behind by the plugin removal).
- Pre-existing failures from the module-migration WIP (extras `.js`-specifier
  resolution in spawned CLI tests, 2781/2860/7193 module semantics,
  documentation link rot for removed docs pages) are unrelated to this change
  and remain open.

## Related

Partially supersedes
[remove the plugin system in favor of programmatic modules](../architecture/2026-10-13-remove-plugin-system-programmatic-modules.md)
(its "/reload keeps reloading settings/skills/prompts/themes" and
"skills, prompts, themes stay local-file based" facts no longer hold) and
updates [get-loaded-resources API](../architecture/2026-10-11-get-loaded-resources-api.md)
(diagnostics no longer include theme conflicts).
