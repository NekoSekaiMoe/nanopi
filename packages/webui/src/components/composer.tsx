"use client";

import { ArrowUp, ImagePlus, Monitor, Square, X } from "lucide-react";
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
	workspaceName,
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
	workspaceName: string;
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
	const currentModel = models.find((model) => model.provider === provider) ?? models[0];

	return (
		<div className="pointer-events-none sticky bottom-0 z-20 bg-background">
			<div className="pointer-events-auto px-3 pb-[max(8px,env(safe-area-inset-bottom))] sm:px-6 lg:px-10">
				<div className="mx-auto w-full max-w-[760px]">
					<div
						className={cn(
							"relative w-full cursor-text rounded-[24px] bg-surface-composer px-3 pb-2 pt-3",
							"ring-1 ring-white/[0.045] transition-shadow focus-within:ring-white/[0.1]",
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
							className="max-h-[200px] min-h-11 w-full resize-none bg-transparent px-1 text-[16px] leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground/80"
						/>

						<div className="mt-1 flex items-center gap-1">
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
								className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
							>
								<ImagePlus className="size-5" strokeWidth={1.6} />
							</button>
							<ModelPicker
								models={models}
								provider={provider}
								onChange={onProvider}
								onConfigure={onConfigure}
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
											: "bg-white/[0.07] text-muted-foreground/60",
									)}
								>
									<ArrowUp className="size-5" strokeWidth={2} />
								</button>
							)}
						</div>

						<div className="mt-2 flex items-center gap-2 border-t border-white/[0.05] pt-2 text-[12px] text-muted-foreground">
							<Monitor className="size-3.5 shrink-0" strokeWidth={1.75} />
							<span className="min-w-0 truncate">{workspaceName || t("本地工作区")}</span>
							{currentModel ? (
								<span className="ml-auto min-w-0 truncate text-muted-foreground/70">
									{currentModel.model}
								</span>
							) : null}
						</div>
					</div>
					<p className="pt-2 text-center text-[10.5px] text-muted-foreground/50 max-md:hidden">
						{t("NanoPi 可能会出错，请核对重要信息。")}
					</p>
				</div>
			</div>
		</div>
	);
}
