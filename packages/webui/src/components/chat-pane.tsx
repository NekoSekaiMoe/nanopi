"use client";

import { AlertCircle, ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Composer } from "@/components/composer";
import { MessageItem } from "@/components/message-item";
import { PermissionCard } from "@/components/permission-card";
import { PlanCard } from "@/components/plan-card";
import { UserInputCard } from "@/components/user-input-card";
import type {
	ApprovalMode,
	ImageData,
	ModelInfo,
	PlanItem,
	UserInputRequestEvent,
	UserInputResponse,
} from "@/lib/api";
import type { TextAttachment } from "@/lib/attachments";
import { type Poem, randomPoem } from "@/lib/greeting";
import type { PendingPermission, PermissionRequest, TurnError, UiMessage } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { getLocale, t } from "@/lib/i18n";

const EFFORT_LABELS: Record<string, string> = {
	off: t("关闭"),
	minimal: t("极低"),
	low: t("低"),
	medium: t("中"),
	high: t("高"),
	xhigh: t("极高"),
	max: t("最高"),
};

const SUGGESTIONS = [
	t("解释一下这个项目的结构"),
	t("找到并修复一个 bug"),
	t("为当前代码补充测试"),
];

export function ChatPane({
	messages,
	loading,
	streaming,
	error,
	notice,
	permission,
	userInput,
	plan,
	models,
	provider,
	onProvider,
	effort,
	onEffort,
	approvalMode,
	onApprovalMode,
	onConfigure,
	onDismissError,
	onDismissNotice,
	onSend,
	onStop,
	onAnswerPermission,
	onAnswerUserInput,
	composer,
	onComposer,
	images,
	onImages,
	files,
	onFiles,
	onNotice,
	sessionName,
	modelSheetOpen,
	onModelSheet,
}: {
	messages: UiMessage[];
	loading: boolean;
	streaming: boolean;
	error: TurnError | null;
	notice: string | null;
	permission: PendingPermission | null;
	userInput: UserInputRequestEvent | null;
	plan: PlanItem[];
	models: ModelInfo[];
	provider: string;
	onProvider: (provider: string) => void;
	effort?: string | null;
	onEffort?: (level: string | null) => void;
	approvalMode: ApprovalMode;
	onApprovalMode: (mode: ApprovalMode) => void;
	onConfigure: () => void;
	onDismissError: () => void;
	onDismissNotice: () => void;
	onSend: () => void;
	onStop: () => void;
	onAnswerPermission: (decision: PermissionRequest) => void;
	onAnswerUserInput: (answer: UserInputResponse) => void;
	composer: string;
	onComposer: (value: string) => void;
	images: ImageData[];
	onImages: (images: ImageData[]) => void;
	files: TextAttachment[];
	onFiles: (files: TextAttachment[]) => void;
	/** One-shot line for something the turn swallowed (a rejected attachment). */
	onNotice: (message: string) => void;
	sessionName: string;
	/** The model sheet is collapsed into the bottom dock, below the composer. */
	modelSheetOpen: boolean;
	onModelSheet: (open: boolean) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const onScroll = () => {
			const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
			stickRef.current = distance < 120;
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => element.removeEventListener("scroll", onScroll);
	}, []);

	const lastText = messages.length
		? messages[messages.length - 1].blocks.map((block) => ("text" in block ? block.text : "")).join("")
		: "";

	useEffect(() => {
		if (!stickRef.current) return;
		const id = requestAnimationFrame(() => {
			bottomRef.current?.scrollIntoView({ block: "end" });
		});
		return () => cancelAnimationFrame(id);
	}, [messages.length, lastText, loading]);

	const welcome = messages.length === 0 && !loading;
	const currentModel = models.find((model) => model.provider === provider) ?? models[0];
	// Same rule as the sheet: only a real level earns a slot on the readout.
	const effortReadout =
		currentModel?.effort_applicable && effort && effort !== "off"
			? EFFORT_LABELS[effort] ?? effort
			: null;
	const modelLabel = currentModel
		? `${currentModel.model}${effortReadout ? ` · ${effortReadout}` : ""}`
		: t("选择模型");

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<div className="mx-auto w-full max-w-[840px] space-y-6 px-4 pt-6 sm:px-6 lg:px-10">
						<div className="flex justify-end">
							<div className="h-12 w-48 animate-pulse rounded-2xl bg-muted" />
						</div>
						<div className="flex flex-col gap-3">
							<div className="h-3 w-[72%] animate-pulse rounded bg-muted" />
							<div className="h-3 w-[61%] animate-pulse rounded bg-muted" />
							<div className="h-3 w-[44%] animate-pulse rounded bg-muted" />
						</div>
					</div>
				) : welcome ? (
					<Welcome onPick={onComposer} models={models} onConfigure={onConfigure} />
				) : (
					<div className="mx-auto w-full max-w-[840px] space-y-6 px-4 pb-8 pt-6 sm:px-6 lg:px-10">
						{messages.map((message) => (
							<MessageItem key={message.id} message={message} />
						))}
						<div ref={bottomRef} />
					</div>
				)}
			</div>

			{/* The dock: capsules stacked on the composer (errors, approvals,
			    follow-up questions) then the composer itself. Welcome mode uses
			    a narrower measure under the greeting; once a conversation
			    exists the composer widens to the message column. Both share the
			    same responsive gutters, so their inner edges never diverge. */}
			<div className={cn("shrink-0", welcome && "pb-[max(16px,env(safe-area-inset-bottom))]")}>
				<div className="mx-auto w-full px-4 sm:px-6 lg:px-10 md:-translate-x-0.5" data-composer-dock>
					<div className={cn("mx-auto w-full", welcome ? "max-w-[44rem]" : "max-w-[840px]")}>
						{error ? (
							<Banner tone="error" onDismiss={onDismissError}>
								{error.code ? (
									<span className="mr-1.5 rounded bg-destructive/15 px-1 font-mono text-caption">
										{error.code}
									</span>
								) : null}
								{error.message}
								{error.retrying ? (
									<span className="ml-1 text-muted-foreground">· {t("正在重试")}</span>
								) : null}
							</Banner>
						) : notice ? (
							<Banner tone="notice" onDismiss={onDismissNotice}>
								{notice}
							</Banner>
						) : null}

						<PlanCard items={plan} streaming={streaming} />

						{permission ? (
							<PermissionCard
								key={`${permission.callId}-${permission.toolName}`}
								pending={permission}
								onAnswer={onAnswerPermission}
							/>
						) : null}
						{userInput ? (
							<UserInputCard
								key={userInput.request_id}
								request={userInput}
								onAnswer={onAnswerUserInput}
							/>
						) : null}

						<Composer
							value={composer}
							onChange={onComposer}
							onSend={onSend}
							onStop={onStop}
							streaming={streaming}
							models={models}
							provider={provider}
							onProvider={onProvider}
							effort={effort}
							onEffort={onEffort}
							approvalMode={approvalMode}
							onApprovalMode={onApprovalMode}
							onConfigure={onConfigure}
							images={images}
							onImages={onImages}
							files={files}
							onFiles={onFiles}
							onNotice={onNotice}
							disabled={models.length === 0}
							modelLabel={modelLabel}
							sheetOpen={modelSheetOpen}
							onSheetOpen={() => onModelSheet(!modelSheetOpen)}
							docked={!welcome}
						/>
						<p className="pt-1.5 pb-[max(8px,env(safe-area-inset-bottom))] text-center text-caption text-muted-foreground max-md:hidden">
							{t("NanoPi 可能会出错，请核对重要信息。")}
						</p>
					</div>
				</div>
				<span className="sr-only">{sessionName}</span>
			</div>
		</div>
	);
}

function Banner({
	tone,
	onDismiss,
	children,
}: {
	tone: "error" | "notice";
	onDismiss: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onDismiss}
			className={cn(
				"flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left text-label leading-5",
				tone === "error"
					? "bg-destructive/12 text-destructive"
					: "bg-muted text-muted-foreground",
			)}
		>
			<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
			<span className="min-w-0 flex-1">{children}</span>
		</button>
	);
}

function Welcome({
	onPick,
	models,
	onConfigure,
}: {
	onPick: (text: string) => void;
	models: ModelInfo[];
	onConfigure: () => void;
}) {
	const hour = new Date().getHours();
	const greeting = hour < 6 ? t("夜深了") : hour < 12 ? t("早上好") : hour < 18 ? t("下午好") : t("晚上好");
	// Chinese landing shows a random classical poem; English keeps the greeting.
	const [poem] = useState<Poem | null>(() => (getLocale() === "zh" ? randomPoem() : null));

	return (
		<div className="mx-auto flex min-h-full w-full max-w-[44rem] flex-col px-4 pb-8 pt-10 sm:px-6 lg:px-10">
			<h1 className="welcome-heading px-4 text-balance text-foreground">
				{poem ? t("想从哪里入手？") : greeting}
			</h1>
			{poem ? (
				<p className="mt-1.5 px-4 text-label leading-6 text-muted-foreground">
					{poem.text}
					<span className="text-muted-foreground/60"> —— {poem.source}</span>
				</p>
			) : (
				<p className="mt-1.5 px-4 text-label leading-6 text-muted-foreground">{t("今天要完成什么？")}</p>
			)}

			{models.length === 0 ? (
				<div className="mt-8 flex flex-col items-start gap-3 px-4">
					<p className="text-control text-muted-foreground">{t("还没有配置模型")}</p>
					<button
						type="button"
						onClick={onConfigure}
						className="press press-fill h-10 rounded-full px-4 text-label text-background"
					>
						{t("去设置")}
					</button>
				</div>
			) : (
				<div className="mt-8 w-full px-4">
					<p className="pb-1 text-caption text-muted-foreground">{t("试试这些")}</p>
					{SUGGESTIONS.map((suggestion, index) => (
						<button
							key={suggestion}
							type="button"
							onClick={() => onPick(suggestion)}
							className={cn(
								"group flex min-h-11 w-full items-center gap-2.5 px-1 text-left text-control text-muted-foreground transition-colors hover:text-foreground",
								index < SUGGESTIONS.length - 1 && "border-b border-border-soft",
							)}
						>
							<Sparkles className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
							<span className="min-w-0 flex-1 truncate">{suggestion}</span>
							<ChevronRight className="size-4 shrink-0 text-muted-foreground/50" strokeWidth={1.75} />
						</button>
					))}
				</div>
			)}
		</div>
	);
}
