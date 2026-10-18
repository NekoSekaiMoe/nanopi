"use client";

import {
	AlertTriangle,
	Brain,
	Check,
	ChevronRight,
	Loader2,
	Terminal,
} from "lucide-react";
import { Markdown } from "@/components/markdown";
import type { ReasoningBlock, ToolBlock, UiBlock, UiMessage } from "@/lib/use-chat";
import { cn } from "@/lib/utils";

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

export function MessageItem({ message }: { message: UiMessage }) {
	if (message.role === "user") {
		return (
			<div className="flex justify-end">
				<div className="flex w-full max-w-[70%] flex-col items-end gap-2 max-md:max-w-[88%]">
					{message.images?.length ? (
						<div className="grid max-w-full grid-cols-2 gap-2">
							{message.images.map((image, index) => (
								<img
									key={`${message.id}-img-${index}`}
									src={`data:${image.media_type};base64,${image.data}`}
									alt=""
									className="max-h-64 rounded-xl border border-border object-cover"
								/>
							))}
						</div>
					) : null}
					{message.blocks.map((block, index) =>
						block.kind === "text" ? (
							<div
								key={`${message.id}-${index}`}
								className="chat-user-bubble w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl bg-chat-user-bubble px-4 py-3 text-[16px] leading-[1.6] text-chat-user-bubble-fg"
							>
								{block.text}
							</div>
						) : null,
					)}
				</div>
			</div>
		);
	}

	if (message.role === "system") {
		return (
			<div className="flex justify-center">
				<div className="max-w-[80%] rounded-lg border border-border-soft bg-muted/40 px-3 py-1.5 text-center text-[11.5px] leading-5 text-muted-foreground">
					{message.blocks.map((block, index) =>
						block.kind === "text" ? <span key={index}>{block.text}</span> : null,
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="min-w-0 space-y-3">
			{message.blocks.length === 0 ? (
				<div className="flex h-7 items-center gap-2 text-[12px] text-muted-foreground">
					<Loader2 className="size-3.5 animate-spin" />
					<span className="shimmer">正在思考</span>
				</div>
			) : null}
			{message.blocks.map((block, index) => (
				<BlockView key={`${message.id}-${index}`} block={block} />
			))}
		</div>
	);
}

function BlockView({ block }: { block: UiBlock }) {
	if (block.kind === "text") {
		return <Markdown content={block.text} />;
	}
	if (block.kind === "reasoning") {
		return <ReasoningView block={block} />;
	}
	return <ToolView block={block} />;
}

function ReasoningView({ block }: { block: ReasoningBlock }) {
	return (
		<details className="group max-w-full text-[12.5px] text-muted-foreground">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 transition-colors hover:text-foreground/80">
				<Brain className="size-3.5 shrink-0" strokeWidth={1.75} />
				<span>思考过程</span>
				<ChevronRight className="size-3 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-1 border-l border-border pl-3 leading-[1.6] whitespace-pre-wrap">
				{block.text}
			</div>
		</details>
	);
}

function ToolView({ block }: { block: ToolBlock }) {
	const running = block.status === "running";
	const failed = block.status === "error";
	const summary = toolSummary(block);
	return (
		<details className="group max-w-full overflow-hidden rounded-lg border border-border-soft bg-muted/30">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
				<span className="grid size-4 shrink-0 place-items-center">
					{running ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : failed ? (
						<AlertTriangle className="size-3.5 text-destructive" />
					) : (
						<Check className="size-3.5 text-success" />
					)}
				</span>
				<Terminal className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
				<span className="shrink-0 font-medium text-foreground/85">{block.name}</span>
				<span className="min-w-0 flex-1 truncate text-[11.5px] opacity-80">{summary}</span>
				{block.durationMs != null ? (
					<span className="shrink-0 text-[10.5px] tabular-nums opacity-60">
						{(block.durationMs / 1000).toFixed(1)}s
					</span>
				) : null}
				<ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
			</summary>
			{block.output ? (
				<pre className="max-h-80 overflow-auto border-t border-border-soft bg-background/60 px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-foreground/80 whitespace-pre-wrap break-words">
					{block.output}
				</pre>
			) : block.progress ? (
				<div className="border-t border-border-soft px-3 py-2 text-[11.5px] text-muted-foreground">
					{block.progress}
				</div>
			) : null}
		</details>
	);
}
