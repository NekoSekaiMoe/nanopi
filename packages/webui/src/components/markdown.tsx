"use client";

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import sql from "shiki/langs/sql.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const shiki = createHighlighterCoreSync({
	themes: [githubLight, githubDark],
	langs: [
		bash,
		css,
		diff,
		go,
		html,
		javascript,
		json,
		markdown,
		python,
		rust,
		sql,
		tsx,
		typescript,
		xml,
		yaml,
	],
	engine: createJavaScriptRegexEngine(),
});

const ALIASES: Record<string, string> = {
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	js: "javascript",
	jsx: "javascript",
	ts: "typescript",
	py: "python",
	rs: "rust",
	yml: "yaml",
	md: "markdown",
	svg: "xml",
};

function highlight(code: string, language: string): string {
	const mapped = ALIASES[language] ?? language;
	const lang = mapped && shiki.getLoadedLanguages().includes(mapped) ? mapped : "text";
	try {
		return shiki.codeToHtml(code, {
			lang,
			themes: { light: "github-light", dark: "github-dark" },
		});
	} catch {
		return `<pre><code>${escapeHtml(code)}</code></pre>`;
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

marked.setOptions({ gfm: true, breaks: false });

const renderer = new marked.Renderer();
renderer.code = function code(source: string, infostring?: string) {
	const text = source ?? "";
	const language = (infostring ?? "").split(/\s+/)[0] ?? "";
	const body = highlight(text, language);
	return (
		`<div class="code-block" data-language="${language}">` +
		`<div class="code-block-head"><span>${language || "code"}</span>` +
		`<button type="button" data-copy="${encodeURIComponent(text)}">{t('复制')}</button></div>` +
		body +
		`</div>`
	);
};

marked.use({ renderer });

export function Markdown({ content, className }: { content: string; className?: string }) {
	const html = useMemo(() => {
		const raw = marked.parse(content ?? "", { async: false }) as string;
		return DOMPurify.sanitize(raw, {
			ADD_ATTR: ["data-copy", "data-language", "style", "tabindex"],
		});
	}, [content]);

	function onClick(event: React.MouseEvent<HTMLDivElement>) {
		const target = event.target as HTMLElement;
		const button = target.closest<HTMLButtonElement>("button[data-copy]");
		if (!button) return;
		const text = button.dataset.copy;
		if (!text) return;
		void navigator.clipboard?.writeText(decodeURIComponent(text));
		button.textContent = t("已复制");
		window.setTimeout(() => {
			if (button.isConnected) button.textContent = t("复制");
		}, 1200);
	}

	return (
		<div
			className={cn("markdown", className)}
			onClick={onClick}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
