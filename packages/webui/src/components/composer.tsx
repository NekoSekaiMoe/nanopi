"use client";

import { ArrowUp, Bot, Laptop, Lightbulb, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ModelPicker, type ReasoningEffort } from "@/components/model-picker";
import { getAiSuggestion } from "@/lib/autocomplete";
import type { ImageData, ModelInfo } from "@/lib/api";
import { cn, readImageFile } from "@/lib/utils";
import { t } from "@/lib/i18n";

export function Composer({
	value,
	onChange,
	onSend,
	onStop,
	streaming,
	models,
	provider,
	onProvider,
	onConfigure,
	reasoningEffort = "medium",
	onReasoningEffort,
	images,
	onImages,
	disabled,
	workspaceName,
	onOpenSuggestions,
	isWelcome,
	tokenPercentage = "2%",
	onOpenEnvironmentMenu,
}: {
	value: string;
	onChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	streaming: boolean;
	models: ModelInfo[];
	provider: string;
	onProvider: (provider: string) => void;
	onConfigure: () => void;
	reasoningEffort?: ReasoningEffort;
	onReasoningEffort?: (effort: ReasoningEffort) => void;
	images: ImageData[];
	onImages: (images: ImageData[]) => void;
	disabled?: boolean;
	workspaceName: string;
	onOpenSuggestions?: () => void;
	isWelcome?: boolean;
	tokenPercentage?: string;
	onOpenEnvironmentMenu?: () => void;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const [dismissedSuggestion, setDismissedSuggestion] = useState(false);

	// Calculate Tab AI association / autocomplete suggestion
	const suggestionResult = dismissedSuggestion ? null : getAiSuggestion(value);
	const suggestion = suggestionResult?.suggestion ?? null;

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		element.style.height = "0px";
		element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
	}, [value]);

	const canSend = (value.trim().length > 0 || images.length > 0) && !streaming && !disabled;

	const acceptSuggestion = () => {
		if (!suggestion) return;
		onChange(value + suggestion);
		setDismissedSuggestion(true);
		ref.current?.focus();
	};

	return (
		<div className="pointer-events-none sticky bottom-0 z-20 bg-background/95 backdrop-blur-sm">
			<div className="pointer-events-auto px-3 pb-[max(8px,env(safe-area-inset-bottom))] sm:px-6 lg:px-8">
				<div className="mx-auto w-full max-w-[760px]">
					{/* Tab AI suggestion chip for mobile and quick acceptance */}
					{suggestion ? (
						<div className="mb-2 flex items-center justify-between px-1">
							<button
								type="button"
								onClick={acceptSuggestion}
								className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-[#1f1f23] px-3 py-1 text-[12px] text-muted-foreground transition-all hover:border-white/[0.2] hover:text-foreground"
							>
								<span className="rounded bg-white/[0.1] px-1 py-0.5 text-[10px] font-medium text-foreground">
									Tab ⇥
								</span>
								<span className="truncate max-w-[280px] sm:max-w-[460px]">
									{suggestion}
								</span>
							</button>
							<button
								type="button"
								onClick={() => setDismissedSuggestion(true)}
								className="text-[11px] text-muted-foreground/60 hover:text-foreground"
							>
								{t("忽略")}
							</button>
						</div>
					) : null}

					{/* Composer Card matching Screenshots 1, 4, 5 */}
					<div
						className={cn(
							"relative w-full cursor-text rounded-[24px] bg-[#1c1c1f] p-3 pt-3.5",
							"border border-white/[0.08] transition-colors focus-within:border-white/[0.18]",
						)}
						onClick={() => ref.current?.focus()}
					>
						{images.length > 0 ? (
							<div className="flex w-full flex-wrap gap-2 pb-2">
								{images.map((image, index) => (
									<div key={index} className="relative">
										<img
											src={`data:${image.media_type};base64,${image.data}`}
											alt=""
											className="size-16 rounded-xl object-cover"
										/>
										<button
											type="button"
											aria-label={t("移除图片")}
											onClick={(event) => {
												event.stopPropagation();
												onImages(images.filter((_, cursor) => cursor !== index));
											}}
											className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-white text-black shadow-sm"
										>
											<X className="size-3" />
										</button>
									</div>
								))}
							</div>
						) : null}

						{/* Textarea container with ghost autocomplete overlay */}
						<div className="relative min-h-11">
							{/* Inline Ghost Suggestion Overlay */}
							{suggestion ? (
								<div
									aria-hidden="true"
									className="pointer-events-none absolute inset-0 select-none px-1 text-[16px] leading-[1.6] whitespace-pre-wrap break-words"
								>
									<span className="opacity-0">{value}</span>
									<span className="text-muted-foreground/45">{suggestion}</span>
								</div>
							) : null}

							<textarea
								ref={ref}
								value={value}
								rows={1}
								placeholder={t("问点什么")}
								onChange={(event) => {
									onChange(event.target.value);
									setDismissedSuggestion(false);
								}}
								onKeyDown={(event) => {
									if (event.key === "Tab" && suggestion) {
										event.preventDefault();
										acceptSuggestion();
										return;
									}
									if (
										event.key === "ArrowRight" &&
										suggestion &&
										ref.current &&
										ref.current.selectionStart === value.length
									) {
										event.preventDefault();
										acceptSuggestion();
										return;
									}
									if (event.key === "Escape") {
										setDismissedSuggestion(true);
										return;
									}
									if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										if (canSend) onSend();
									}
								}}
								className="relative z-10 max-h-[200px] min-h-11 w-full resize-none bg-transparent px-1 text-[16px] leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground/70"
							/>
						</div>

						{/* Bottom row inside composer card */}
						<div className="mt-1 flex items-center gap-1.5">
							<input
								ref={fileRef}
								type="file"
								accept="image/*"
								multiple
								hidden
								onChange={(event) => {
									const files = [...(event.target.files ?? [])];
									event.target.value = "";
									if (files.length === 0) return;
									void Promise.all(files.map(readImageFile)).then((next) => onImages([...images, ...next]));
								}}
							/>
							<button
								type="button"
								aria-label={t("添加附件")}
								title={t("添加附件")}
								onClick={(event) => {
									event.stopPropagation();
									fileRef.current?.click();
								}}
								className="grid size-9 place-items-center rounded-full text-muted-foreground/90 transition-colors hover:bg-white/[0.06] hover:text-foreground"
							>
								<Plus className="size-5" strokeWidth={2} />
							</button>

							<ModelPicker
								models={models}
								provider={provider}
								onChange={onProvider}
								onConfigure={onConfigure}
								reasoningEffort={reasoningEffort}
								onReasoningEffort={onReasoningEffort}
								compact
							/>

							<div className="flex-1" />

							{streaming ? (
								<button
									type="button"
									aria-label={t("停止")}
									title={t("停止")}
									onClick={(event) => {
										event.stopPropagation();
										onStop();
									}}
									className="grid size-10 place-items-center rounded-full bg-[#ded6ff] text-[#18121f] transition-opacity hover:opacity-90"
								>
									<Square className="size-3.5 fill-current" />
								</button>
							) : (
								<button
									type="button"
									aria-label={t("发送")}
									title={t("发送")}
									disabled={!canSend}
									onClick={(event) => {
										event.stopPropagation();
										onSend();
									}}
									className={cn(
										"grid size-10 place-items-center rounded-full transition-colors",
										canSend
											? "bg-[#ded6ff] text-[#18121f] hover:opacity-90"
											: "bg-[#353539] text-[#71717a]",
									)}
								>
									<ArrowUp className="size-5" strokeWidth={2.2} />
								</button>
							)}
						</div>
					</div>

					{/* Bottom Toolbar matching Screenshots 1, 3, 4 */}
					<div className="mt-2.5 flex items-center justify-between px-2 text-[12.5px] text-muted-foreground">
						{/* Left: Cloud Computer / Environment switcher */}
						<button
							type="button"
							onClick={onOpenEnvironmentMenu}
							className="flex items-center gap-1.5 transition-colors hover:text-foreground"
						>
							<Laptop className="size-4 shrink-0" strokeWidth={1.75} />
							<span>{t("云端电脑")}</span>
							<span className="text-[10px] opacity-60">∨</span>
						</button>

						{/* Center: Bot / Memoh */}
						<div className="flex items-center gap-1.5 text-muted-foreground/90">
							<Bot className="size-4 shrink-0" strokeWidth={1.75} />
							<span className="truncate max-w-[140px]">{workspaceName || "Memoh"}</span>
							<span className="text-[10px] opacity-60">∨</span>
						</div>

						{/* Right: Context percentage or Try These */}
						{isWelcome ? (
							<button
								type="button"
								onClick={onOpenSuggestions}
								className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
							>
								<Lightbulb className="size-4 shrink-0" strokeWidth={1.75} />
								<span>{t("试试这些")}</span>
							</button>
						) : (
							<div className="flex items-center gap-1.5 text-[12px] text-muted-foreground/80">
								<span className="size-2 rounded-full border border-current" />
								<span>{tokenPercentage}</span>
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
