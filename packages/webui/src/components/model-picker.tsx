"use client";

import { Check, ChevronDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModelInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/**
 * Reasoning levels in the order the backend lists them. `effort_levels`
 * excludes "off" (`getSupportedThinkingLevels` is filtered), so the gate that
 * decides whether a model can think at all has to allow for it.
 */
const EFFORT_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const EFFORT_LABELS: Record<string, string> = {
	off: t("关闭"),
	minimal: t("极低"),
	low: t("低"),
	medium: t("中"),
	high: t("高"),
	xhigh: t("极高"),
	max: t("最高"),
};

function effortLabel(level: string | null): string {
	if (!level) return t("默认");
	return EFFORT_LABELS[level] ?? level;
}

/** True when the model supports a real thinking level (anything but "off"). */
function canThink(model: ModelInfo | undefined): boolean {
	return Boolean(model?.effort_applicable) && model !== undefined && model.effort_levels.some((level) => level !== "off");
}

/** Levels to offer: the model's own list, or the ladder when it sends none. */
function effortChoices(model: ModelInfo | undefined): string[] {
	if (!model) return [];
	const listed = model.effort_levels.filter((level) => level !== "off");
	if (listed.length > 0) return listed;
	return EFFORT_LADDER.filter((level) => level !== "off");
}

/**
 * Model + thinking effort, as one bottom sheet.
 *
 * Memoh puts both in a panel that slides up from the composer (its
 * composer-model-menu.vue), not in a dropdown anchored above the input: the
 * list is long, half of it would fall off a phone screen, and on the welcome
 * page the dropdown covered the greeting. The sheet is edge-to-edge on mobile,
 * a centered card above the bottom edge on desktop, and lists a `模型` section
 * and a `思考强度` section in one scroll — picking either closes it.
 *
 * `思考强度` is a flat list of rows, one level each, checkmark on the current
 * one, the way Memoh draws its reasoning submenu. The chip row it replaced
 * wrapped onto a second line past four levels, so `极高` and `最高` sat
 * somewhere else on the sheet than the rest, and the pill used `bg-foreground`
 * for the active level, the same weight as a primary button, which read as
 * "nothing selected" on the dark surface.
 */
export function ModelSheet({
	open,
	onClose,
	models,
	provider,
	onProvider,
	effort,
	onEffort,
	onConfigure,
}: {
	open: boolean;
	onClose: () => void;
	models: ModelInfo[];
	provider: string;
	onProvider: (provider: string) => void;
	effort?: string | null;
	onEffort?: (level: string | null) => void;
	onConfigure: () => void;
}) {
	const current = models.find((model) => model.provider === provider) ?? models[0];
	const activeEffort = effort ?? current?.reasoning_effort ?? null;
	const levels = onEffort && canThink(current) ? effortChoices(current) : [];
	const [mounted, setMounted] = useState(false);

	// Two frames: the sheet has to exist with its closed transform before the
	// class flip, or the browser skips the transition entirely.
	useEffect(() => {
		if (!open) {
			setMounted(false);
			return;
		}
		const id = requestAnimationFrame(() => setMounted(true));
		return () => cancelAnimationFrame(id);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-end justify-center md:items-center">
			<button
				type="button"
				aria-label={t("关闭")}
				onClick={onClose}
				className={cn(
					"absolute inset-0 cursor-default bg-black/40 transition-opacity duration-200",
					mounted ? "opacity-100" : "opacity-0",
				)}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={t("模型")}
				className={cn(
					"relative flex w-full flex-col",
					// One max-height cap for both sizes: two utilities (`max-h-…` and
					// `md:max-h-…`) land in the same property and the emitted order
					// made the desktop cap win below md as well.
					"max-h-[80dvh]",
					// Desktop lifts the card off the bottom edge; the padding lives on
					// the wrapper, because the sheet itself is pinned to the edge and a
					// margin would only show a seam of scrim underneath it.
					"rounded-t-2xl bg-popover pb-[env(safe-area-inset-bottom)] md:w-[26rem] md:rounded-2xl md:pb-0",
					"transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
					mounted ? "translate-y-0 opacity-100" : "translate-y-full opacity-0",
					"md:translate-y-3 md:shadow-xl",
				)}
			>
				<header className="flex h-11 shrink-0 items-center gap-1 pl-4 pr-1.5">
					<span className="min-w-0 flex-1 truncate text-control font-medium text-foreground">{t("模型")}</span>
					<button
						type="button"
						aria-label={t("关闭")}
						onClick={onClose}
						className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-overlay-hover hover:text-foreground"
					>
						<X className="size-4" strokeWidth={1.75} />
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
					<SheetLabel>{t("模型")}</SheetLabel>
					{models.length === 0 ? (
						<div className="px-2 py-6 text-center">
							<p className="text-label text-muted-foreground">{t("还没有配置模型")}</p>
							<button
								type="button"
								onClick={() => {
									onClose();
									onConfigure();
								}}
								className="mt-2 h-8 rounded-full bg-foreground px-3 text-label text-background"
							>
								{t("去设置")}
							</button>
						</div>
					) : (
						models.map((model) => {
							const active = model.provider === current?.provider;
							return (
								<button
									key={model.provider}
									type="button"
									disabled={!model.available}
									title={model.available ? undefined : t("未配置凭证，补上 API Key 后可用")}
									onClick={() => {
										onProvider(model.provider);
										onClose();
									}}
									className={cn(
										"flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
										model.available ? "hover:bg-overlay-hover" : "opacity-45",
									)}
								>
									<span className="mt-0.5 grid size-4 shrink-0 place-items-center">
										{active ? <Check className="size-3.5 text-brand" strokeWidth={2.25} /> : null}
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-control text-foreground">{model.model}</span>
										<span className="block truncate text-caption text-muted-foreground">
											{model.provider}
											{model.available ? "" : ` · ${t("未配置凭证")}`}
										</span>
									</span>
								</button>
							);
						})
					)}

					{levels.length > 0 ? (
						<>
							<div className="pt-3">
								<SheetLabel>{t("思考强度")}</SheetLabel>
							</div>
							<div className="py-0.5">
								{levels.map((level) => {
									const active = level === activeEffort;
									return (
										<button
											key={level}
											type="button"
											aria-pressed={active}
											onClick={() => {
												onEffort?.(level);
												onClose();
											}}
											className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-overlay-hover"
										>
											<span className="grid size-4 shrink-0 place-items-center">
												{active ? <Check className="size-3.5 text-brand" strokeWidth={2.25} /> : null}
											</span>
											<span className="min-w-0 flex-1 truncate text-control text-foreground">
												{effortLabel(level)}
											</span>
										</button>
									);
								})}
							</div>
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}

/** Group label inside the sheet: same rung as the sidebar's section labels. */
function SheetLabel({ children }: { children: React.ReactNode }) {
	return (
		<p className="select-none px-2.5 pb-1 pt-2 text-caption font-[550] tracking-[-0.02em] text-muted-foreground/80">
			{children}
		</p>
	);
}
