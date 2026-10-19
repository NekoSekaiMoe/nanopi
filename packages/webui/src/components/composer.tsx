"use client";

import { ChevronDown, ImagePlus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { ModelSheet } from "@/components/model-picker";
import type { ImageData, ModelInfo } from "@/lib/api";
import { cn, readImageFile } from "@/lib/utils";
import { t } from "@/lib/i18n";

/**
 * The composer is always a two-row card: textarea on top, controls below.
 * Shape never depends on content, so nothing animates mid-typing. Geometry
 * follows Memoh's composer-capsule contract — flat capsule, inset hairline,
 * padding from --composer-pad, controls pinned to the bottom row.
 *
 * The bottom row reads `+ | 模型 · 强度 | ↑` with no chip in the middle: the
 * model name is bare text that opens the model sheet (Memoh's
 * composer-model-menu), which is where both the model and the thinking level
 * are picked. The workspace/branch line that used to sit under the capsule is
 * gone with it — the sidebar header already carries the same pair.
 */
export function Composer({
	value,
	onChange,
	onSend,
	onStop,
	streaming,
	modelLabel,
	sheetOpen,
	onSheetOpen,
	models,
	provider,
	onProvider,
	effort,
	onEffort,
	onConfigure,
	images,
	onImages,
	disabled,
	docked,
}: {
	value: string;
	onChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	streaming: boolean;
	/** Current model readout; it doubles as the sheet's trigger. */
	modelLabel: string;
	sheetOpen: boolean;
	onSheetOpen: () => void;
	models: ModelInfo[];
	provider: string;
	onProvider: (provider: string) => void;
	effort?: string | null;
	onEffort?: (level: string | null) => void;
	onConfigure: () => void;
	images: ImageData[];
	onImages: (images: ImageData[]) => void;
	disabled?: boolean;
	docked?: boolean;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		element.style.height = "0px";
		element.style.height = `${Math.min(element.scrollHeight, 208)}px`;
	}, [value]);

	const canSend = (value.trim().length > 0 || images.length > 0) && !streaming && !disabled;

	return (
		<div className="w-full">
			<div
				className={cn("composer-shell cursor-text", docked && "composer-shell-docked")}
				onClick={() => ref.current?.focus()}
			>
				{images.length > 0 ? (
					<div className="flex w-full flex-wrap gap-2 pb-1.5">
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
									className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background"
								>
									<X className="size-3" />
								</button>
							</div>
						))}
					</div>
				) : null}

				<textarea
					ref={ref}
					value={value}
					rows={1}
					placeholder={t("问点什么")}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							if (canSend) onSend();
						}
					}}
					className={cn(
						"w-full resize-none break-words bg-transparent pl-2 pr-1 pt-2 pb-1.5 text-base leading-[var(--chat-leading)]",
						"text-foreground outline-none placeholder:text-[color:var(--field-placeholder)]",
						docked ? "min-h-10" : "min-h-12",
					)}
				/>

				<div className="flex items-center gap-1.5">
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
						aria-label={t("添加图片")}
						title={t("添加图片")}
						onClick={(event) => {
							event.stopPropagation();
							fileRef.current?.click();
						}}
						className="press grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground max-md:size-11"
					>
						<ImagePlus className="size-4 max-md:size-5" strokeWidth={1.75} />
					</button>

					{/* Model readout, bare text: picking lives in the sheet, so the
					    trigger carries no pill chrome. */}
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onSheetOpen();
						}}
						aria-haspopup="dialog"
						aria-expanded={sheetOpen}
						title={modelLabel}
						className={cn(
							"-ml-0.5 inline-flex h-8 min-w-0 flex-1 items-center gap-0.5 rounded-lg pl-1.5 pr-1",
							"text-label text-control-label transition-colors hover:text-control-label-hover max-md:h-11",
						)}
					>
						<span className="min-w-0 truncate">{modelLabel}</span>
						<ChevronDown className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
					</button>

					{/* Send and stop are one circle: the surface never changes
					    between states, only the glyph cross-fades, so the button
					    can't blink mid-turn. */}
					<button
						type="button"
						aria-label={streaming ? t("停止") : t("发送")}
						title={streaming ? t("停止") : t("发送")}
						disabled={!streaming && !canSend}
						onClick={(event) => {
							event.stopPropagation();
							if (streaming) onStop();
							else onSend();
						}}
						className={cn(
							"press press-brand relative grid shrink-0 place-items-center rounded-full",
							"size-8 text-brand-foreground max-md:size-11",
							!streaming && !canSend && "opacity-40",
						)}
					>
						<span className="grid size-[18px] place-items-center max-md:size-5">
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth={2.5}
								strokeLinecap="round"
								strokeLinejoin="round"
								className={cn(
									"col-start-1 row-start-1 size-[18px] transition-opacity duration-200 ease-out max-md:size-5",
									streaming ? "opacity-0" : "opacity-100",
								)}
								aria-hidden="true"
							>
								<path d="M12 19 V5.75" />
								<path d="M6.5 10.5 L12 5 L17.5 10.5" />
							</svg>
							<svg
								viewBox="0 0 24 24"
								fill="currentColor"
								className={cn(
									"col-start-1 row-start-1 size-4 transition-opacity duration-200 ease-out max-md:size-4.5",
									streaming ? "opacity-100" : "opacity-0",
								)}
								aria-hidden="true"
							>
								<rect x="4" y="4" width="16" height="16" rx="3" />
							</svg>
						</span>
					</button>
				</div>
			</div>

			<ModelSheet
				open={sheetOpen}
				onClose={() => onSheetOpen()}
				models={models}
				provider={provider}
				onProvider={onProvider}
				effort={effort}
				onEffort={onEffort}
				onConfigure={onConfigure}
			/>
		</div>
	);
}
