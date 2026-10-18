"use client";

import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { ModelPicker } from "@/components/model-picker";
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
	images,
	onImages,
	disabled,
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
	images: ImageData[];
	onImages: (images: ImageData[]) => void;
	disabled?: boolean;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		element.style.height = "0px";
		element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
	}, [value]);

	const canSend = (value.trim().length > 0 || images.length > 0) && !streaming && !disabled;

	return (
		<div className="pointer-events-none sticky bottom-0 z-20">
			<div className="pointer-events-none h-8 bg-gradient-to-t from-background to-transparent" />
			<div className="pointer-events-auto bg-background px-4 pb-[max(10px,env(safe-area-inset-bottom))] sm:px-6 lg:px-10">
				<div className="mx-auto w-full max-w-[840px]">
					<div
						className={cn(
							"relative flex w-full cursor-text flex-wrap content-between items-end gap-1 rounded-2xl border border-border bg-surface-composer p-2.5 max-md:rounded-3xl",
							"focus-within:border-foreground/25",
						)}
						onClick={() => ref.current?.focus()}
					>
						{images.length > 0 ? (
							<div className="order-first flex w-full basis-full flex-wrap gap-2 pb-1.5">
								{images.map((image, index) => (
									<div key={index} className="relative">
										<img
											src={`data:${image.media_type};base64,${image.data}`}
											alt=""
											className="size-16 rounded-lg border border-border object-cover"
										/>
										<button
											type="button"
											aria-label={t("移除图片")}
											onClick={(event) => {
												event.stopPropagation();
												onImages(images.filter((_, cursor) => cursor !== index));
											}}
											className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground"
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
							placeholder={t("给 NanoPi 发消息…")}
							onChange={(event) => onChange(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									if (canSend) onSend();
								}
							}}
							className="max-h-[200px] min-h-10 w-full resize-none bg-transparent px-1.5 py-1.5 text-[16px] leading-[1.55] text-foreground outline-none placeholder:text-muted-foreground max-md:text-[16px]"
						/>

						<div className="flex w-full basis-full items-center gap-0.5 pt-0.5">
							<ModelPicker
								models={models}
								provider={provider}
								onChange={onProvider}
								onConfigure={onConfigure}
								compact
							/>
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
								className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:size-11"
							>
								<ImagePlus className="size-4 max-md:size-5" strokeWidth={1.75} />
							</button>
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
									className="grid size-8 place-items-center rounded-lg bg-foreground text-background transition-opacity hover:opacity-85 max-md:size-11"
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
										"grid size-8 place-items-center rounded-lg transition-colors max-md:size-11",
										canSend
											? "bg-brand text-brand-foreground hover:bg-brand/90"
											: "bg-muted text-muted-foreground",
									)}
								>
									<ArrowUp className="size-4" strokeWidth={2.25} />
								</button>
							)}
						</div>
					</div>
					<p className="pt-1.5 text-center text-[10.5px] text-muted-foreground/70 max-md:hidden">
						{t("NanoPi 可能会出错，请核对重要信息。")}
					</p>
				</div>
			</div>
		</div>
	);
}
