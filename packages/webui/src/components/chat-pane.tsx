"use client";

import { AlertCircle, ChevronRight, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Composer } from "@/components/composer";
import { MessageItem } from "@/components/message-item";
import { PermissionCard } from "@/components/permission-card";
import { UserInputCard } from "@/components/user-input-card";
import type { ImageData, ModelInfo, UserInputRequestEvent, UserInputResponse } from "@/lib/api";
import { type Poem, randomPoem } from "@/lib/greeting";
import type { PendingPermission, TurnError, UiMessage } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { getLocale, t } from "@/lib/i18n";

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
	models,
	provider,
	onProvider,
	effort,
	onEffort,
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
	sessionName,
	workspaceName,
	branch,
}: {
	messages: UiMessage[];
	loading: boolean;
	streaming: boolean;
	error: TurnError | null;
	notice: string | null;
	permission: PendingPermission | null;
	userInput: UserInputRequestEvent | null;
	models: ModelInfo[];
	provider: string;
	onProvider: (provider: string) => void;
	effort?: string | null;
	onEffort?: (level: string | null) => void;
	onConfigure: () => void;
	onDismissError: () => void;
	onDismissNotice: () => void;
	onSend: () => void;
	onStop: () => void;
	onAnswerPermission: (decision: "allow" | "deny" | "allow_session") => void;
	onAnswerUserInput: (answer: UserInputResponse) => void;
	composer: string;
	onComposer: (value: string) => void;
	images: ImageData[];
	onImages: (images: ImageData[]) => void;
	sessionName: string;
	workspaceName: string;
	branch?: string;
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

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<div className="mx-auto w-full max-w-[760px] space-y-5 px-4 py-8 sm:px-6 lg:px-10">
						<div className="ml-auto h-12 w-48 animate-pulse rounded-2xl bg-muted" />
						<div className="space-y-2">
							<div className="h-3 w-[72%] animate-pulse rounded bg-muted" />
							<div className="h-3 w-[61%] animate-pulse rounded bg-muted" />
							<div className="h-3 w-[44%] animate-pulse rounded bg-muted" />
						</div>
					</div>
				) : welcome ? (
					<Welcome onPick={(text) => onComposer(text)} models={models} onConfigure={onConfigure} />
				) : (
					<div className="mx-auto w-full max-w-[760px] space-y-7 px-4 pb-8 pt-5 sm:px-6 lg:px-10">
						{messages.map((message) => (
							<MessageItem key={message.id} message={message} />
						))}
						<div ref={bottomRef} />
					</div>
				)}
			</div>

			<div className="shrink-0">
				{error ? (
					<Banner tone="error" onDismiss={onDismissError}>
						{error.code ? (
							<span className="mr-1.5 rounded bg-destructive/15 px-1 font-mono text-[11px]">
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
					onConfigure={onConfigure}
					images={images}
					onImages={onImages}
					disabled={models.length === 0}
					workspaceName={workspaceName}
					branch={branch}
				/>
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
		<div className="mx-auto w-full max-w-[840px] px-4 pb-2 sm:px-6 lg:px-10">
			<button
				type="button"
				onClick={onDismiss}
				className={cn(
					"flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left text-[12px] leading-5",
					tone === "error"
						? "border-destructive/30 bg-destructive/5 text-destructive"
						: "border-border bg-muted/40 text-muted-foreground",
				)}
			>
				<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
				<span className="min-w-0 flex-1">{children}</span>
			</button>
		</div>
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
		<div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-5 pb-10 pt-16 sm:px-8">
			<h1 className="text-[28px] font-normal leading-[1.35] tracking-[-0.02em] text-foreground">
				{poem ? t("想从哪里入手？") : greeting}
			</h1>
			<p className="mt-2 text-[13.5px] leading-6 text-muted-foreground">
				{poem ? (
					<>
						{poem.text}
						<span className="text-muted-foreground/60"> —— {poem.source}</span>
					</>
				) : (
					t("今天要完成什么？")
				)}
			</p>

			{models.length === 0 ? (
				<div className="mt-8 flex flex-col items-start gap-3">
					<p className="text-[13px] text-muted-foreground">{t("还没有配置模型")}</p>
					<button
						type="button"
						onClick={onConfigure}
						className="h-10 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-85"
					>
						{t("去设置")}
					</button>
				</div>
			) : (
				<div className="mt-10 w-full">
					<p className="mb-2 px-1 text-[12px] text-muted-foreground/70">{t("试试这些")}</p>
					<div className="overflow-hidden rounded-2xl bg-white/[0.03]">
						{SUGGESTIONS.map((suggestion, index) => (
							<button
								key={suggestion}
								type="button"
								onClick={() => onPick(suggestion)}
								className={cn(
									"flex h-12 w-full items-center gap-3 px-3.5 text-left text-[14.5px] text-foreground/85 transition-colors hover:bg-white/[0.04] hover:text-foreground",
									index < SUGGESTIONS.length - 1 && "border-b border-white/[0.05]",
								)}
							>
								<Sparkles className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
								<span className="min-w-0 flex-1 truncate">{suggestion}</span>
								<ChevronRight className="size-4 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
