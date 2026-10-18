"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTerminal } from "@/lib/use-terminal";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/**
 * Scratch shell for the workspace. Commands go through `/terminal` (one shell
 * per connection) and stay out of the agent transcript, so a quick `git status`
 * costs no context.
 */
export function TerminalPane({ cwd }: { cwd: string }) {
	const { entries, connected, error, run, clear } = useTerminal(cwd);
	const [command, setCommand] = useState("");
	const [history, setHistory] = useState<string[]>([]);
	const [cursor, setCursor] = useState(-1);
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [entries]);

	function submit() {
		const value = command.trim();
		if (!value) return;
		run(value);
		setHistory((current) => [...current, value].slice(-50));
		setCursor(-1);
		setCommand("");
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
				<span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={cwd}>
					{cwd || t("本地工作区")}
				</span>
				<span
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						error ? "bg-destructive" : connected ? "bg-success" : "bg-muted-foreground/40",
					)}
					title={error ?? (connected ? t("已连接") : t("未连接"))}
				/>
				<button
					type="button"
					aria-label={t("清空终端")}
					title={t("清空终端")}
					onClick={clear}
					className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<Trash2 className="size-3.5" strokeWidth={1.75} />
				</button>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 font-mono text-[12px] leading-[1.55]">
				{error ? <p className="pb-2 text-destructive">{error}</p> : null}
				{entries.length === 0 ? (
					<p className="text-muted-foreground/70">{t("命令只在本机执行，不进入对话上下文。")}</p>
				) : null}
				{entries.map((entry) => (
					<div key={entry.id} className="pb-2">
						<div className="flex items-start gap-1.5">
							<span className="shrink-0 text-brand">$</span>
							<span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
								{entry.command}
							</span>
						</div>
						{entry.output ? (
							<pre className="whitespace-pre-wrap break-words text-foreground/75">{entry.output}</pre>
						) : null}
						{entry.running ? (
							<span className="flex items-center gap-1.5 text-muted-foreground">
								<Loader2 className="size-3 animate-spin" />
								{t("运行中…")}
							</span>
						) : entry.error ? (
							<span className="text-destructive">{entry.error}</span>
						) : (
							<span className={cn("text-[11px]", entry.code === 0 ? "text-muted-foreground/60" : "text-destructive/80")}>
								{t("退出码")} {entry.code ?? "?"}
							</span>
						)}
					</div>
				))}
				<div ref={bottomRef} />
			</div>

			<div className="shrink-0 border-t border-border p-2">
				<div className="flex items-center gap-1.5 rounded-xl bg-muted/60 px-2.5">
					<span className="shrink-0 font-mono text-[12px] text-brand">$</span>
					<input
						value={command}
						spellCheck={false}
						autoComplete="off"
						placeholder={t("输入命令，回车执行")}
						onChange={(event) => setCommand(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.nativeEvent.isComposing) {
								event.preventDefault();
								submit();
								return;
							}
							if (event.key === "ArrowUp" && history.length > 0) {
								event.preventDefault();
								const next = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
								setCursor(next);
								setCommand(history[next]);
							}
							if (event.key === "ArrowDown" && history.length > 0) {
								event.preventDefault();
								const next = cursor < 0 ? -1 : cursor + 1;
								if (next >= history.length) {
									setCursor(-1);
									setCommand("");
								} else {
									setCursor(next);
									setCommand(history[next]);
								}
							}
						}}
						className="h-10 min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
					/>
				</div>
			</div>
		</div>
	);
}
