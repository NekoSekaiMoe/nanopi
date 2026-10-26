"use client";

import { ShieldAlert } from "lucide-react";
import type { PendingPermission, PermissionRequest } from "@/lib/use-chat";
import { t } from "@/lib/i18n";

export function PermissionCard({
	pending,
	onAnswer,
}: {
	pending: PendingPermission;
	onAnswer: (decision: PermissionRequest) => void;
}) {
	const raw = pending.arguments;
	const args = typeof raw === "string" ? raw : JSON.stringify(raw ?? {}, null, 2);

	return (
		<div className="mx-auto w-full max-w-[840px] px-4 pb-2 sm:px-6 lg:px-10">
			<div className="rounded-2xl border border-border bg-card p-3.5">
				<div className="flex items-start gap-2.5">
					<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
						<ShieldAlert className="size-4" strokeWidth={1.75} />
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex items-baseline gap-2">
							<h3 className="text-label font-medium text-foreground">{t('需要确认')}</h3>
							<span className="truncate text-caption text-muted-foreground">{pending.toolName}</span>
						</div>
						<p className="mt-0.5 text-caption leading-5 text-muted-foreground">{pending.reason}</p>
						{args && args !== "{}" ? (
							<pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-muted px-2.5 py-2 font-mono text-caption leading-[1.5] text-muted-foreground whitespace-pre-wrap break-words">
								{args.slice(0, 2000)}
							</pre>
						) : null}
						<p className="mt-2 text-caption leading-5 text-muted-foreground">
							{pending.explaining
								? t("解释如下，读完后在这里决定：只允许这一次、本次会话允许，或拒绝。")
								: t("拒绝和只允许这一次都只针对这一次调用；本次会话允许会记住这个工具；让 AI 决定则由模型裁决这一类调用。")}
						</p>
						<div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
							{pending.explainable && !pending.explaining ? (
								<button
									type="button"
									onClick={() => onAnswer("explain")}
									className="h-8 rounded-lg px-2.5 text-label text-muted-foreground transition-colors hover:bg-overlay-hover hover:text-foreground"
								>
									{t("解释这次调用")}
								</button>
							) : null}
							<button
								type="button"
								onClick={() => onAnswer("deny")}
								className="h-8 rounded-lg px-2.5 text-label text-muted-foreground transition-colors hover:bg-overlay-hover hover:text-foreground"
							>
								{t("拒绝")}
							</button>
							<button
								type="button"
								onClick={() => onAnswer("ai_decide")}
								className="h-8 rounded-lg px-2.5 text-label text-muted-foreground transition-colors hover:bg-overlay-hover hover:text-foreground"
							>
								{t("让 AI 决定")}
							</button>
							<button
								type="button"
								onClick={() => onAnswer("allow_session")}
								className="h-8 rounded-lg border border-border px-2.5 text-label text-foreground transition-colors hover:bg-overlay-hover"
							>
								{t("本次会话允许")}
							</button>
							<button
								type="button"
								onClick={() => onAnswer("allow_once")}
								className="h-8 rounded-lg border border-border px-2.5 text-label text-foreground transition-colors hover:bg-overlay-hover"
							>
								{t("只允许这一次")}
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
