"use client";

import {
	AlertCircle,
	ArrowDown,
	ChevronRight,
	Globe,
	MessageSquare,
	Monitor,
	Sparkles,
	Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Composer } from "@/components/composer";
import { MessageItem } from "@/components/message-item";
import { PermissionCard } from "@/components/permission-card";
import { UserInputCard } from "@/components/user-input-card";
import type { ReasoningEffort } from "@/components/model-picker";
import type { ImageData, ModelInfo, UserInputRequestEvent, UserInputResponse } from "@/lib/api";
import { type Poem, randomPoem } from "@/lib/greeting";
import type { PendingPermission, UiMessage } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { getLocale, t } from "@/lib/i18n";

const SUGGESTIONS = [
	t("解释一下这个项目的结构"),
	t("找到并修复一个 bug"),
	t("为当前代码补充测试"),
];

export type EnvironmentMode = "chat" | "terminal" | "browser" | "desktop";

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
	workspaceName,
	reasoningEffort = "medium",
	onReasoningEffort,
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
	workspaceName: string;
	reasoningEffort?: ReasoningEffort;
	onReasoningEffort?: (effort: ReasoningEffort) => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	const [showScrollDown, setShowScrollDown] = useState(false);
	const [envMenuOpen, setEnvMenuOpen] = useState(false);
	const [envMode, setEnvMode] = useState<EnvironmentMode>("chat");
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const onScroll = () => {
			const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
			stickRef.current = distance < 120;
			setShowScrollDown(distance > 240);
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

	const scrollToBottom = () => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	};

	const welcome = messages.length === 0 && !loading;

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<div className="mx-auto w-full max-w-[760px] space-y-5 px-4 py-8 sm:px-6 lg:px-8">
						<div className="ml-auto h-12 w-48 animate-pulse rounded-2xl bg-white/[0.05]" />
						<div className="space-y-2">
							<div className="h-3 w-[72%] animate-pulse rounded bg-white/[0.05]" />
							<div className="h-3 w-[61%] animate-pulse rounded bg-white/[0.05]" />
							<div className="h-3 w-[44%] animate-pulse rounded bg-white/[0.05]" />
						</div>
					</div>
				) : welcome ? (
					<Welcome
						onPick={(text) => onComposer(text)}
						models={models}
						onConfigure={onConfigure}
						suggestionsOpen={suggestionsOpen}
						onToggleSuggestions={() => setSuggestionsOpen((v) => !v)}
					/>
				) : (
					<div className="mx-auto w-full max-w-[760px] space-y-7 px-4 pb-8 pt-5 sm:px-6 lg:px-8">
						{messages.map((message) => (
							<MessageItem key={message.id} message={message} />
						))}
						<div ref={bottomRef} />
					</div>
				)}
			</div>

			{/* Floating Scroll Down button matching Screenshot 1 */}
			{showScrollDown && !welcome ? (
				<button
					type="button"
					aria-label={t("回到底部")}
					onClick={scrollToBottom}
					className="absolute bottom-28 left-1/2 z-30 -translate-x-1/2 grid size-10 place-items-center rounded-full border border-white/[0.1] bg-[#1f1f23] text-foreground shadow-lg transition-transform hover:scale-105 active:scale-95"
				>
					<ArrowDown className="size-5" strokeWidth={2} />
				</button>
			) : null}

			{/* Environment Popover Menu matching Screenshot 3 */}
			{envMenuOpen ? (
				<>
					<button
						type="button"
						aria-label="close menu"
						onClick={() => setEnvMenuOpen(false)}
						className="fixed inset-0 z-30 cursor-default"
					/>
					<div className="absolute bottom-14 left-4 z-40 w-44 rounded-2xl border border-white/[0.1] bg-[#1a1a1d] p-1.5 shadow-2xl">
						{(
							[
								["chat", t("对话"), <MessageSquare key="chat" className="size-4" />],
								["terminal", t("终端"), <Terminal key="term" className="size-4" />],
								["browser", t("浏览器"), <Globe key="browser" className="size-4" />],
								["desktop", t("桌面"), <Monitor key="desktop" className="size-4" />],
							] as const
						).map(([mode, label, icon]) => (
							<button
								key={mode}
								type="button"
								onClick={() => {
									setEnvMode(mode);
									setEnvMenuOpen(false);
								}}
								className={cn(
									"flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-[14px] transition-colors",
									envMode === mode
										? "bg-white/[0.08] font-medium text-foreground"
										: "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
								)}
							>
								{icon}
								<span>{label}</span>
							</button>
						))}
					</div>
				</>
			) : null}

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
					reasoningEffort={reasoningEffort}
					onReasoningEffort={onReasoningEffort}
					images={images}
					onImages={onImages}
					disabled={models.length === 0}
					workspaceName={workspaceName}
					isWelcome={welcome}
					onOpenSuggestions={() => setSuggestionsOpen((v) => !v)}
					onOpenEnvironmentMenu={() => setEnvMenuOpen((v) => !v)}
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
		<div className="mx-auto w-full max-w-[840px] px-4 pb-2 sm:px-6 lg:px-8">
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

/**
 * Empty / Welcome State matching Screenshot 4:
 * - Headline: "来，搞定一件事。"
 * - Subtitle: Random Chinese Classical Poetry ({poem.text} —— {poem.source})
 * - Suggestions panel
 */
function Welcome({
	onPick,
	models,
	onConfigure,
	suggestionsOpen,
	onToggleSuggestions,
}: {
	onPick: (text: string) => void;
	models: ModelInfo[];
	onConfigure: () => void;
	suggestionsOpen?: boolean;
	onToggleSuggestions?: () => void;
}) {
	// Preserve random classical poetry
	const [poem] = useState<Poem | null>(() => (getLocale() === "zh" ? randomPoem() : null));

	return (
		<div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-6 pb-12 pt-20 sm:px-8">
			{/* Headline matching Screenshot 4 */}
			<h1 className="text-[30px] font-semibold leading-[1.3] tracking-[-0.02em] text-foreground">
				{t("来，搞定一件事。")}
			</h1>

			{/* Random Classical Poetry subtitle */}
			{poem ? (
				<p className="mt-2.5 text-[14px] leading-6 text-muted-foreground/80">
					{poem.text}
					<span className="text-muted-foreground/50"> —— {poem.source}</span>
				</p>
			) : (
				<p className="mt-2.5 text-[14px] leading-6 text-muted-foreground/80">
					{t("今天要完成什么？")}
				</p>
			)}

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
					{suggestionsOpen ? (
						<div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-[#1a1a1d]">
							{SUGGESTIONS.map((suggestion, index) => (
								<button
									key={suggestion}
									type="button"
									onClick={() => onPick(suggestion)}
									className={cn(
										"flex h-12 w-full items-center gap-3 px-3.5 text-left text-[14px] text-foreground/85 transition-colors hover:bg-white/[0.04] hover:text-foreground",
										index < SUGGESTIONS.length - 1 && "border-b border-white/[0.05]",
									)}
								>
									<Sparkles className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
									<span className="min-w-0 flex-1 truncate">{suggestion}</span>
									<ChevronRight className="size-4 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />
								</button>
							))}
						</div>
					) : null}
				</div>
			)}
		</div>
	);
}
