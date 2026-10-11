/** Open Codex-style input frame with an embedded model toolbar. */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Editor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bgRgb, FRAME_STOPS, gradientText } from "./gradient.ts";
import type { ReferenceUiState } from "./state.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function isEditorBorder(line: string): boolean {
  return /^─+(?: [↑↓] \d+ more )?─*$/.test(stripAnsi(line));
}

function fitLine(text: string, width: number, ellipsis: string): string {
  const fitted = truncateToWidth(text, width, ellipsis);
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function fitBorder(line: string, width: number): string {
  const fitted = truncateToWidth(stripAnsi(line), width, "");
  return fitted + "─".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function hideLeadingShellBang(line: string, width: number): string {
  const bangIndex = line.indexOf("!");
  if (bangIndex < 0) return line;
  return fitLine(line.slice(0, bangIndex) + line.slice(bangIndex + 1), width, "");
}

function providerLabel(provider: string): string {
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    google: "Google",
    openai: "OpenAI",
    "openai-codex": "OpenAI",
    xai: "xAI",
  };
  if (known[provider]) return known[provider]!;
  return provider
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function renderModelToolbar(ctx: ExtensionContext, pi: ExtensionAPI, width: number): string {
  const theme = ctx.ui.theme;
  const model = ctx.model;
  const parts = [theme.fg("text", model?.id ?? "no-model")];

  if (model?.provider) parts.push(theme.fg("muted", providerLabel(model.provider)));
  if (model?.reasoning) parts.push(theme.fg("muted", pi.getThinkingLevel()));

  return truncateToWidth(parts.join("  "), Math.max(0, width), theme.fg("dim", "…"));
}

export function makeReferenceEditorFactory(ctx: ExtensionContext, pi: ExtensionAPI, uiState: ReferenceUiState) {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): CustomEditor => {
    class ReferenceEditor extends CustomEditor {
      private pasteInProgress = false;
      // Rows this render placed above the input frame: reserved padding then
      // the autocomplete menu. The base Editor's hit-testing assumes the menu
      // sits below the bottom border, so handleMouse remaps rows onto that
      // geometry using these counts.
      private menuPaddingRows = 0;
      private menuRows = 0;

      constructor() {
        super(tui, theme, keybindings, { paddingX: 0 });
        // NOTE: never enable tui.setClearOnShrink(true) here. It is a TUI-wide
        // switch: any component shrinking by any amount forces a full
        // screen+scrollback clear (visible flicker during fast streaming).
        // pi-tui's differential renderer clears stale tail rows itself
        // (verified in 0.80.10+), so the shrink case needs no help.
      }

      private syncShellMode(): void {
        const shellMode = this.getText().startsWith("!");
        if (uiState.shellMode === shellMode) return;
        uiState.shellMode = shellMode;
        tui.requestRender();
      }

      override handleInput(data: string): void {
        if (data.includes("\x1b[200~")) this.pasteInProgress = true;
        const isPasteInput = this.pasteInProgress;
        if (data.includes("\x1b[201~")) this.pasteInProgress = false;

        if (isPasteInput) {
          // CustomEditor checks app shortcuts before Editor sees bracketed paste.
          // Bypass that layer so newlines cannot submit separate queued prompts.
          Editor.prototype.handleInput.call(this, data);
          this.syncShellMode();
          return;
        }

        super.handleInput(data);
        this.syncShellMode();
      }

      override setText(text: string): void {
        super.setText(text);
        this.syncShellMode();
      }

      render(width: number): string[] {
        if (width < 3) return super.render(width);

        // Reserve one column for the solid accent and one for its inner gap. Keeping every
        // byte of the base line intact is important: focused lines contain
        // Pi's zero-width CURSOR_MARKER control sequence.
        const lines = super.render(width - 2);
        const bottomIndex = lines.findIndex((line, index) => index > 0 && isEditorBorder(line));
        if (bottomIndex < 0) return lines;

        // A background-colored cell fills the terminal row completely, unlike
        // box/block glyphs which can expose gaps with custom line-height fonts.
        const vertical = bgRgb(" ", FRAME_STOPS[0]!);
        const top = gradientText(fitBorder(lines[0]!, width), FRAME_STOPS);
        const spacer = `${vertical}${" ".repeat(width - 1)}`;
        const editorLines = lines.slice(1, bottomIndex);
        if (uiState.shellMode && editorLines[0]) {
          // Pi still receives !command on submit; only the shell-mode prefix is
          // hidden so the command begins at the same column as a normal prompt.
          editorLines[0] = hideLeadingShellBang(editorLines[0], width - 2);
        }
        const content = editorLines.map((line) => `${vertical} ${line}`);
        // The reference keeps the cursor visually centered between the frame
        // rules: one blank row above the editor content and one below it.
        const body = [spacer, ...content, spacer];
        const toolbar = fitLine(
          `${vertical} ${renderModelToolbar(ctx, pi, width - 2)}`,
          width,
          ctx.ui.theme.fg("dim", "…"),
        );
        const bottom = gradientText(fitBorder(lines[bottomIndex]!, width), FRAME_STOPS);
        const autocomplete = lines.slice(bottomIndex + 1).map((line) => fitLine(line, width, ""));
        // Pi's base Editor appends autocomplete below its border. Keep the
        // prompt fixed while a menu is open, but do not reserve those rows when
        // the menu is idle; otherwise Working and the prompt drift apart.
        const menuPadding =
          autocomplete.length > 0
            ? Array.from(
                { length: Math.max(0, this.getAutocompleteMaxVisible() - autocomplete.length) },
                () => " ".repeat(width),
              )
            : [];
        this.menuPaddingRows = menuPadding.length;
        this.menuRows = autocomplete.length;
        return [...menuPadding, ...autocomplete, top, ...body, toolbar, bottom];
      }

      override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        // Layout: [padding][menu][top rule][spacer][content][spacer][toolbar][bottom rule].
        // Map clicks onto the base Editor geometry ([top][content][bottom][menu]) so
        // menu selection and cursor placement keep working with the menu on top.
        const padding = this.menuPaddingRows;
        const menuEnd = padding + this.menuRows;
        const contentEnd = menuEnd + 2 + this.renderedVisibleLineCount;
        if (event.y < padding) return undefined; // reserved blank rows: let text selection run
        if (event.y < menuEnd) {
          return super.handleMouse({
            ...event,
            y: this.renderedVisibleLineCount + 2 + (event.y - padding),
          });
        }
        if (event.y > contentEnd) {
          // Trailing spacer, toolbar, and bottom rule: focus only, never menu hits.
          return event.type === "click" && event.button === "left" ? { handled: true, focus: true } : undefined;
        }
        return super.handleMouse({ ...event, y: event.y - (menuEnd + 1) });
      }
    }

    return new ReferenceEditor();
  };
}
