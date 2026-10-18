"use client";

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked } from "marked";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const ALIASES: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	py: "python",
	rs: "rust",
	yml: "yaml",
	md: "markdown",
	html: "xml",
	svg: "xml",
};

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function highlight(code: string, language: string): string {
	const mapped = ALIASES[language] ?? language;
	if (!mapped || !hljs.getLanguage(mapped)) return escapeHtml(code);
	try {
		return hljs.highlight(code, { language: mapped, ignoreIllegals: true }).value;
	} catch {
		return escapeHtml(code);
	}
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
		`<button type="button" data-copy="${encodeURIComponent(text)}">复制</button></div>` +
		`<pre><code class="hljs">${body}</code></pre>` +
		`</div>`
	);
};

marked.use({ renderer });

export function Markdown({ content, className }: { content: string; className?: string }) {
	const html = useMemo(() => {
		const raw = marked.parse(content ?? "", { async: false }) as string;
		return DOMPurify.sanitize(raw, {
			ADD_ATTR: ["data-copy", "data-language"],
		});
	}, [content]);

	function onClick(event: React.MouseEvent<HTMLDivElement>) {
		const target = event.target as HTMLElement;
		const button = target.closest<HTMLButtonElement>("button[data-copy]");
		if (!button) return;
		const text = button.dataset.copy;
		if (!text) return;
		void navigator.clipboard?.writeText(decodeURIComponent(text));
		button.textContent = "已复制";
		window.setTimeout(() => {
			if (button.isConnected) button.textContent = "复制";
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
