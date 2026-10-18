"use client";

import { AlertCircle, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import { Composer } from "@/components/composer";
import { Logo } from "@/components/logo";
import { MessageItem } from "@/components/message-item";
import { PermissionCard } from "@/components/permission-card";
import { UserInputCard } from "@/components/user-input-card";
import type { ImageData, ModelInfo, UserInputRequestEvent, UserInputResponse } from "@/lib/api";
import type { PendingPermission, UiMessage } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

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
}: {
	messages: UiMessage[];
	loading: boolean;
	streaming: boolean;
	error: string | null;
	notice: string | null;
	permission: PendingPermission | null;
	userInput: UserInputRequestEvent | null;
	models: ModelInfo[];
	provider: string;
	onProvider: (provider: string) => void;
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
					<div className="mx-auto w-full max-w-[840px] space-y-5 px-4 py-8 sm:px-6 lg:px-10">
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
					<div className="mx-auto w-full max-w-[840px] space-y-6 px-4 pb-8 pt-6 sm:px-6 lg:px-10">
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
						{error}
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
					onConfigure={onConfigure}
					images={images}
					onImages={onImages}
					disabled={models.length === 0}
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

	return (
		<div className="mx-auto flex min-h-full w-full max-w-[840px] flex-col items-center justify-center px-6 py-16 text-center">
			<Logo size={48} className="shadow-lg" />
			<h1 className="mt-5 text-[26px] font-semibold tracking-[-0.03em] text-foreground">
				{greeting}
			</h1>
			<p className="mt-1.5 text-[14px] text-muted-foreground">{t('今天要完成什么？')}</p>

			{models.length === 0 ? (
				<div className="mt-6 flex flex-col items-center gap-2">
					<p className="text-[12px] text-muted-foreground">{t('还没有配置模型')}</p>
					<button
						type="button"
						onClick={onConfigure}
						className="h-8 rounded-lg bg-foreground px-3 text-[12px] font-medium text-background transition-opacity hover:opacity-85"
					>
						{t("去设置")}
					</button>
				</div>
			) : (
				<div className="mt-7 flex flex-wrap justify-center gap-2">
					{SUGGESTIONS.map((suggestion) => (
						<button
							key={suggestion}
							type="button"
							onClick={() => onPick(suggestion)}
							className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-[12px] text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
						>
							<Sparkles className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
							{suggestion}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
