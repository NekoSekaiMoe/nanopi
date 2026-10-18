"use client";

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

marked.setOptions({ gfm: true, breaks: false });

const renderer = new marked.Renderer();
renderer.code = function code(code: string, infostring?: string) {
	const text = code ?? "";
	const language = (infostring ?? "").split(/\s+/)[0] ?? "";
	const escaped = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
	return (
		`<div class="code-block" data-language="${language}">` +
		`<div class="code-block-head"><span>${language || "code"}</span>` +
		`<button type="button" data-copy="${encodeURIComponent(text)}">复制</button></div>` +
		`<pre><code>${escaped}</code></pre>` +
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
