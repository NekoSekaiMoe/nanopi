"use client";

import { FileWarning, Loader2, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type FileContent, readFile, writeFile } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

function languageOf(path: string): string {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		json: "json",
		css: "css",
		html: "html",
		md: "markdown",
		py: "python",
		rs: "rust",
		go: "go",
		sh: "bash",
		yml: "yaml",
		yaml: "yaml",
		sql: "sql",
	};
	return map[ext] ?? "";
}

/**
 * Inline file view for the workspace. The daemon cannot focus a host editor, so
 * the sidebar opens the file here: markdown renders, everything else shows as a
 * fenced code block through the shared highlighter. Editable text files can be
 * saved back over `/fs/write`.
 */
export function FileViewer({
	path,
	onClose,
}: {
	path: string;
	onClose: () => void;
}) {
	const [file, setFile] = useState<FileContent | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setFile(null);
		setError(null);
		setDraft(null);
		void readFile(path)
			.then((result) => {
				if (!cancelled) setFile(result);
			})
			.catch((cause) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	const name = path.split("/").filter(Boolean).pop() ?? path;
	const language = languageOf(path);
	const dirty = draft !== null && draft !== file?.content;

	async function save() {
		if (draft === null) return;
		setSaving(true);
		setError(null);
		try {
			await writeFile(path, draft);
			setFile((current) => (current ? { ...current, content: draft } : current));
			setDraft(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
				<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground" title={path}>
					{path}
				</span>
				{dirty ? (
					<button
						type="button"
						onClick={() => void save()}
						disabled={saving}
						className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-2.5 text-[12px] font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-40"
					>
						<Save className="size-3.5" />
						{saving ? t("保存中…") : t("保存")}
					</button>
				) : null}
				<button
					type="button"
					aria-label={t("关闭文件")}
					onClick={onClose}
					className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<X className="size-4" strokeWidth={1.75} />
				</button>
			</header>

			<div className="min-h-0 flex-1 overflow-auto px-4 py-4">
				{error ? (
					<div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
						{error}
					</div>
				) : file === null ? (
					<div className="flex items-center gap-2 text-[13px] text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" />
						{t("加载中…")}
					</div>
				) : file.binary || file.truncated ? (
					<div className="flex items-center gap-2 rounded-xl border border-border px-3 py-3 text-[12.5px] text-muted-foreground">
						<FileWarning className="size-4 shrink-0" />
						{file.truncated ? t("文件过大，无法预览") : t("二进制文件，无法预览")}
						<span className="text-muted-foreground/60">({file.size} B)</span>
					</div>
				) : (
					<div className="mx-auto w-full max-w-[900px]">
						{language === "markdown" && draft === null ? (
							<Markdown content={file.content} />
						) : (
							<textarea
								value={draft ?? file.content}
								spellCheck={false}
								onChange={(event) => setDraft(event.target.value)}
								className={cn(
									"min-h-[60vh] w-full resize-none rounded-xl border border-border bg-surface-editor p-3",
									"font-mono text-[12.5px] leading-[1.6] text-foreground outline-none focus:border-foreground/25",
								)}
							/>
						)}
						{language === "markdown" && draft === null ? (
							<button
								type="button"
								onClick={() => setDraft(file.content)}
								className="mt-3 h-8 rounded-lg border border-border px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								{t("编辑")}
							</button>
						) : null}
						<p className="pb-3 pt-2 text-[10.5px] text-muted-foreground/60">
							{file.size} B · {language || "text"}
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
