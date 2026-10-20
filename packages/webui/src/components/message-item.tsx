"use client";

import { AlertTriangle, Check, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import type { ReasoningBlock, TextBlock, ToolBlock, UiBlock, UiMessage } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

function toolSummary(block: ToolBlock): string {
	const display = block.display?.trim();
	if (display) return display.replace(/\s+/g, " ").slice(0, 120);
	if (block.args && typeof block.args === "object") {
		const record = block.args as Record<string, unknown>;
		for (const key of ["command", "path", "pattern", "url", "query"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) {
				return value.replace(/\s+/g, " ").slice(0, 120);
			}
		}
	}
	const args = typeof block.args === "string" ? block.args : JSON.stringify(block.args ?? "");
	return (args || "").replace(/\s+/g, " ").slice(0, 120);
}

type ProcessBlock = ToolBlock | ReasoningBlock;

type Segment =
	| { kind: "text"; block: TextBlock }
	| { kind: "process"; blocks: ProcessBlock[] };

function segment(blocks: UiBlock[]): Segment[] {
	const segments: Segment[] = [];
	for (const block of blocks) {
		if (block.kind === "text") {
			segments.push({ kind: "text", block });
			continue;
		}
		const last = segments[segments.length - 1];
		if (last?.kind === "process") last.blocks.push(block);
		else segments.push({ kind: "process", blocks: [block] });
	}
	return segments;
}

/**
 * Splits a message into CJK / Latin runs so each script takes its paired
 * weight: MiSans reads heavier than Inter at the same numeric weight, so one
 * element-level font-weight can never be right for a mixed string.
 */
function MessageText({ text }: { text: string }) {
	const runs = text.match(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]+|[^\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]+/g);
	if (!runs) return <>{text}</>;
	return (
		<>
			{runs.map((run, index) => (
				<span key={index} className={/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(run) ? "chat-cjk" : "chat-latin"}>
					{run}
				</span>
			))}
		</>
	);
}

export function MessageItem({ message }: { message: UiMessage }) {
	if (message.role === "user") {
		const text = message.blocks
			.map((block) => (block.kind === "text" ? block.text : ""))
			.join("")
			.trim();
		return (
			<div className="flex justify-end">
				<div className="flex w-full max-w-[85%] flex-col items-end gap-2">
					{message.images?.length ? (
						<div className="grid max-w-full grid-cols-2 gap-2">
							{message.images.map((image, index) => (
								<img
									key={`${message.id}-img-${index}`}
									src={`data:${image.media_type};base64,${image.data}`}
									alt=""
									className="max-h-64 rounded-2xl object-cover"
								/>
							))}
						</div>
					) : null}
					{text ? (
						<div
							data-chat-content
							className="chat-user-bubble w-fit max-w-full bg-chat-user-bubble px-4 py-3 text-chat-user-bubble-fg whitespace-pre-wrap break-words"
							style={{ borderRadius: "var(--radius-2xl)" }}
						>
							<MessageText text={text} />
						</div>
					) : null}
				</div>
			</div>
		);
	}

	if (message.role === "system") {
		return (
			<div className="flex justify-center">
				<div className="max-w-[80%] rounded-xl bg-muted px-3 py-1.5 text-center text-label leading-5 text-muted-foreground">
					{message.blocks.map((block, index) =>
						block.kind === "text" ? <span key={index}>{block.text}</span> : null,
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="min-w-0 space-y-4">
			{message.blocks.length === 0 ? (
				<div className="flex h-7 items-center gap-2 text-label text-muted-foreground">
					<Loader2 className="size-3.5 animate-spin" />
					<span className="shimmer">{t("正在思考")}</span>
				</div>
			) : null}
			{message.provider ? (
				// A session can span models; name the one behind this reply so the
				// transcript never disagrees with the picker.
				<p className="select-none text-caption text-muted-foreground/70">{message.provider}</p>
			) : null}
			{segment(message.blocks).map((item, index) =>
				item.kind === "text" ? (
					<Markdown key={`${message.id}-text-${index}`} content={item.block.text} />
				) : (
					<ProcessGroup key={`${message.id}-process-${index}`} blocks={item.blocks} />
				),
			)}
		</div>
	);
}

function ProcessGroup({ blocks }: { blocks: ProcessBlock[] }) {
	const tools = blocks.filter((block): block is ToolBlock => block.kind === "tool");
	const running = tools.some((block) => block.status === "running");
	const [open, setOpen] = useState(running);

	useEffect(() => {
		if (running) setOpen(true);
	}, [running]);

	const reasoningCount = blocks.length - tools.length;
	const label =
		tools.length > 0
			? `${t("已运行")} ${tools.length} ${t("条命令")}`
			: `${t("已思考")}${reasoningCount > 1 ? ` ${reasoningCount} ${t("次")}` : ""}`;

	return (
		<div className="min-w-0">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex w-full items-center gap-1.5 py-px text-left text-control text-cop-title transition-colors duration-75 hover:text-foreground"
			>
				<span className={cn("truncate", running && "shimmer")}>{label}</span>
				<ChevronRight
					className={cn("size-4 shrink-0 transition-transform duration-150", open && "rotate-90")}
					strokeWidth={1.75}
				/>
			</button>
			{open ? (
				<div className="mt-1 space-y-0.5 rounded-xl bg-muted p-1.5">
					{blocks.map((block, index) =>
						block.kind === "tool" ? (
							<ToolRow key={block.id} block={block} />
						) : (
							<ReasoningRow key={`r-${index}`} block={block} />
						),
					)}
				</div>
			) : null}
		</div>
	);
}

function ToolRow({ block }: { block: ToolBlock }) {
	const summary = toolSummary(block);
	return (
		<details className="group rounded-lg transition-colors hover:bg-overlay-hover open:bg-overlay-hover-light">
			<summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-2.5 text-control text-foreground">
				<span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
					{block.status === "running" ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : block.status === "error" ? (
						<AlertTriangle className="size-3.5 text-destructive" />
					) : (
						<Check className="size-3.5 text-success/80" />
					)}
				</span>
				<span className="min-w-0 flex-1 truncate">{summary || block.name}</span>
				<ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
			</summary>
			{block.output ? (
				<pre className="max-h-80 overflow-auto border-t border-border-soft px-3 py-2.5 font-mono text-caption leading-[1.6] text-muted-foreground whitespace-pre-wrap break-words">
					{block.output}
				</pre>
			) : block.progress ? (
				<div className="border-t border-border-soft px-3 py-2 text-label text-muted-foreground">
					{block.progress}
				</div>
			) : null}
		</details>
	);
}

function ReasoningRow({ block }: { block: ReasoningBlock }) {
	return (
		<details className="group rounded-lg transition-colors hover:bg-overlay-hover open:bg-overlay-hover-light">
			<summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-2.5 text-control text-muted-foreground">
				<span className="min-w-0 flex-1 truncate">{t("已思考")}</span>
				<ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
			</summary>
			<div className="max-h-72 overflow-auto border-t border-border-soft px-3 py-2.5 text-control leading-relaxed text-muted-foreground whitespace-pre-wrap">
				{block.text}
			</div>
		</details>
	);
}
