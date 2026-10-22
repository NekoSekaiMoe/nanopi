"use client";

import { Check, ChevronRight, Circle, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlanItem } from "@/lib/api";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

/**
 * The session plan, mirrored from the `todo` tool's results.
 *
 * The todo tool runs in every mode and its list outlives a turn, but the
 * transcript only shows the calls that built it. The plan gets its own seat
 * above the composer: open while anything is unfinished, collapsed to a single
 * `3/8 steps` header once the whole plan is closed out, so a finished plan
 * does not hold the composer down.
 */
export function PlanCard({ items, streaming }: { items: PlanItem[]; streaming: boolean }) {
	const [reopened, setReopened] = useState(false);
	const total = items.length;
	const done = items.filter((item) => item.status === "completed").length;
	const open = items.filter((item) => item.status === "pending" || item.status === "in_progress").length;
	const current =
		items.find((item) => item.status === "in_progress") ??
		items.find((item) => item.status === "pending");

	// A plan arriving mid-turn is what the user is waiting on; show it, and drop
	// a manual collapse from the previous plan.
	useEffect(() => {
		if (open > 0) setReopened(false);
	}, [open]);

	if (total === 0) return null;
	const collapsed = open === 0 && !reopened;

	return (
		<div className="mx-auto w-full max-w-[840px] px-4 pb-2 sm:px-6 lg:px-10">
			<div className="rounded-2xl border border-border bg-card p-3.5">
				<div className="flex items-center gap-2">
					<span className="grid size-4 shrink-0 place-items-center">
						{open > 0 && streaming ? (
							<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
						) : open > 0 ? (
							<Circle className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
						) : (
							<Check className="size-3.5 text-success/80" strokeWidth={2} />
						)}
					</span>
					<span className="min-w-0 flex-1 truncate text-label font-medium text-foreground">
						{done}/{total} {t("步骤")}
						{open > 0 && current ? (
							<span className="ml-1.5 font-normal text-muted-foreground">{current.text}</span>
						) : null}
					</span>
					{open === 0 ? (
						<button
							type="button"
							onClick={() => setReopened((value) => !value)}
							aria-expanded={!collapsed}
							aria-label={collapsed ? t("展开步骤") : t("收起步骤")}
							className="press grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
						>
							<ChevronRight
								className={cn(
									"size-4 transition-transform duration-150",
									!collapsed && "rotate-90",
								)}
								strokeWidth={1.75}
							/>
						</button>
					) : null}
				</div>
				{collapsed ? null : (
					<ol className="mt-2 space-y-1">
						{items.map((item) => (
							<PlanRow key={item.id} item={item} />
						))}
					</ol>
				)}
			</div>
		</div>
	);
}

function PlanRow({ item }: { item: PlanItem }) {
	const cancelled = item.status === "cancelled";
	return (
		<li className="flex items-start gap-2 text-control leading-5">
			<span className="mt-0.5 grid size-4 shrink-0 place-items-center">
				{item.status === "completed" ? (
					<Check className="size-3.5 text-success/80" strokeWidth={2} />
				) : item.status === "in_progress" ? (
					<Loader2 className="size-3.5 animate-spin text-brand" />
				) : cancelled ? (
					<X className="size-3.5 text-muted-foreground/60" strokeWidth={2} />
				) : (
					<span className="size-1.5 rounded-full bg-muted-foreground/40" />
				)}
			</span>
			<span
				className={cn(
					"min-w-0 flex-1 break-words",
					cancelled
						? "text-muted-foreground/60 line-through"
						: item.status === "completed"
							? "text-muted-foreground"
							: "text-foreground",
				)}
			>
				{item.text}
				{item.isVerification ? (
					<span className="ml-1.5 text-caption text-muted-foreground/70">{t("验证")}</span>
				) : null}
			</span>
		</li>
	);
}
