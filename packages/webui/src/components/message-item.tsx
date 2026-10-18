"use client";

import {
	AlertTriangle,
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	Loader2,
	MoreHorizontal,
	RotateCw,
} from "lucide-react";
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

export function MessageItem({
	message,
	onRetry,
}: {
	message: UiMessage;
	onRetry?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);

	if (message.role === "user") {
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
					{message.blocks.map((block, index) =>
						block.kind === "text" ? (
							<div
								key={`${message.id}-${index}`}
								className="w-fit max-w-full whitespace-pre-wrap break-words rounded-[22px] bg-[#5f3dbb] px-4.5 py-3 text-[16px] leading-[1.6] text-white shadow-sm"
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
				<div className="max-w-[80%] rounded-xl bg-white/[0.04] px-3 py-1.5 text-center text-[12px] leading-5 text-muted-foreground">
					{message.blocks.map((block, index) =>
						block.kind === "text" ? <span key={index}>{block.text}</span> : null,
					)}
				</div>
			</div>
		);
	}

	const fullText = message.blocks
		.map((b) => (b.kind === "text" ? b.text : ""))
		.filter(Boolean)
		.join("\n\n");

	const handleCopy = () => {
		if (!fullText) return;
		void navigator.clipboard.writeText(fullText).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	};

	return (
		<div className="min-w-0 space-y-4">
			{message.blocks.length === 0 ? (
				<div className="flex h-7 items-center gap-2 text-[13.5px] text-muted-foreground">
					<Loader2 className="size-3.5 animate-spin" />
					<span className="shimmer">{t("正在思考")}</span>
				</div>
			) : null}

			{segment(message.blocks).map((item, index) =>
				item.kind === "text" ? (
					<Markdown key={`${message.id}-text-${index}`} content={item.block.text} />
				) : (
					<ProcessCard key={`${message.id}-process-${index}`} blocks={item.blocks} />
				),
			)}

			{/* Assistant Message Actions matching Screenshot 3 */}
			{fullText ? (
				<div className="relative flex items-center gap-1 pt-1 text-muted-foreground">
					<button
						type="button"
						aria-label={t("复制")}
						title={t("复制")}
						onClick={handleCopy}
						className="grid size-8 place-items-center rounded-lg hover:bg-white/[0.06] hover:text-foreground"
					>
						{copied ? <Check className="size-4 text-green-400" /> : <Copy className="size-4" strokeWidth={1.75} />}
					</button>

					{onRetry ? (
						<button
							type="button"
							aria-label={t("重试")}
							title={t("重试")}
							onClick={onRetry}
							className="grid size-8 place-items-center rounded-lg hover:bg-white/[0.06] hover:text-foreground"
						>
							<RotateCw className="size-4" strokeWidth={1.75} />
						</button>
					) : null}

					<div className="relative">
						<button
							type="button"
							aria-label={t("更多")}
							title={t("更多")}
							onClick={() => setMoreOpen((v) => !v)}
							className="grid size-8 place-items-center rounded-lg hover:bg-white/[0.06] hover:text-foreground"
						>
							<MoreHorizontal className="size-4" strokeWidth={1.75} />
						</button>
						{moreOpen ? (
							<>
								<button
									type="button"
									aria-label="close"
									onClick={() => setMoreOpen(false)}
									className="fixed inset-0 z-20 cursor-default"
								/>
								<div className="absolute left-0 top-full z-30 mt-1 min-w-[120px] rounded-xl border border-white/[0.1] bg-[#1a1a1d] p-1 shadow-lg text-[13px] text-foreground">
									<button
										type="button"
										onClick={() => {
											handleCopy();
											setMoreOpen(false);
										}}
										className="w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-white/[0.06]"
									>
										{t("复制内容")}
									</button>
								</div>
							</>
						) : null}
					</div>
				</div>
			) : null}
		</div>
	);
}

/**
 * Process Card matching Screenshot 1:
 * - Collapsible overview: "已探索 1 次搜索、1 条命令 ∨"
 * - Process Card box:
 *   - "已思考 2 秒 ∨"
 *   - Reasoning thought text
 *   - Action steps ("查看可用的电脑 >", "Collect system hardware and OS info >", ...)
 */
function ProcessCard({ blocks }: { blocks: ProcessBlock[] }) {
	const tools = blocks.filter((block): block is ToolBlock => block.kind === "tool");
	const reasonings = blocks.filter((block): block is ReasoningBlock => block.kind === "reasoning");
	const running = tools.some((block) => block.status === "running");

	const [cardOpen, setCardOpen] = useState(true);
	const [thoughtOpen, setThoughtOpen] = useState(true);

	useEffect(() => {
		if (running) {
			setCardOpen(true);
			setThoughtOpen(true);
		}
	}, [running]);

	// Format summary text like "已探索 1 次搜索、1 条命令 ∨"
	const toolCount = tools.length;
	const summaryText =
		toolCount > 0
			? `${t("已探索")} ${toolCount} ${t("条命令")}`
			: `${t("已思考")}${reasonings.length > 1 ? ` ${reasonings.length} ${t("次")}` : ""}`;

	const firstReasoningText = reasonings.map((r) => r.text).join("\n\n");

	return (
		<div className="min-w-0 space-y-2">
			{/* Overview row matching Screenshot 1 */}
			<button
				type="button"
				onClick={() => setCardOpen((v) => !v)}
				className="flex items-center gap-1.5 text-left text-[14.5px] text-muted-foreground transition-colors hover:text-foreground"
			>
				<span className={cn(running && "shimmer")}>{summaryText}</span>
				<ChevronDown
					className={cn("size-4 shrink-0 transition-transform duration-200", !cardOpen && "-rotate-90")}
					strokeWidth={1.75}
				/>
			</button>

			{/* Process Card Container */}
			{cardOpen ? (
				<div className="rounded-2xl border border-white/[0.06] bg-[#1a1a1d] p-3 text-[14px]">
					{/* Collapsible Thinking header */}
					{firstReasoningText ? (
						<div className="pb-2">
							<button
								type="button"
								onClick={() => setThoughtOpen((v) => !v)}
								className="flex items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground"
							>
								<span>{t("已思考 2 秒")}</span>
								<ChevronDown
									className={cn("size-3.5 transition-transform duration-200", !thoughtOpen && "-rotate-90")}
									strokeWidth={1.75}
								/>
							</button>
							{thoughtOpen ? (
								<p className="mt-2 text-[13.5px] leading-[1.65] text-muted-foreground whitespace-pre-wrap">
									{firstReasoningText}
								</p>
							) : null}
						</div>
					) : null}

					{/* Tool action rows matching Screenshot 1 */}
					{tools.length > 0 ? (
						<div className="space-y-1 pt-1">
							{tools.map((tool) => (
								<ToolActionRow key={tool.id} tool={tool} />
							))}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function ToolActionRow({ tool }: { tool: ToolBlock }) {
	const [expanded, setExpanded] = useState(false);
	const summary = toolSummary(tool) || tool.name;

	return (
		<div className="rounded-xl transition-colors hover:bg-white/[0.03]">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="flex h-9 w-full items-center justify-between px-2 text-left text-[13.5px] text-muted-foreground transition-colors hover:text-foreground"
			>
				<span className="min-w-0 flex-1 truncate">{summary}</span>
				<div className="flex items-center gap-1.5 shrink-0 pl-2">
					{tool.status === "running" ? (
						<Loader2 className="size-3.5 animate-spin text-brand" />
					) : tool.status === "error" ? (
						<AlertTriangle className="size-3.5 text-destructive" />
					) : null}
					<ChevronRight
						className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-90")}
						strokeWidth={1.75}
					/>
				</div>
			</button>
			{expanded && (tool.output || tool.progress) ? (
				<pre className="max-h-80 overflow-auto border-t border-white/[0.05] p-2.5 font-mono text-[11.5px] leading-[1.6] text-muted-foreground whitespace-pre-wrap break-words">
					{tool.output || tool.progress}
				</pre>
			) : null}
		</div>
	);
}
