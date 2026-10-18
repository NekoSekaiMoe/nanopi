"use client";

import { ShieldAlert } from "lucide-react";
import type { PendingPermission } from "@/lib/use-chat";

export function PermissionCard({
	pending,
	onAnswer,
}: {
	pending: PendingPermission;
	onAnswer: (decision: "allow" | "deny" | "allow_session") => void;
}) {
	const args =
		typeof pending.args === "string" ? pending.args : JSON.stringify(pending.args ?? {}, null, 2);

	return (
		<div className="mx-auto w-full max-w-[840px] px-4 pb-2 sm:px-6 lg:px-10">
			<div className="rounded-2xl border border-border bg-card p-3">
				<div className="flex items-start gap-2.5">
					<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
						<ShieldAlert className="size-4" strokeWidth={1.75} />
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex items-baseline gap-2">
							<h3 className="text-[12.5px] font-medium text-foreground">需要确认</h3>
							<span className="truncate text-[11.5px] text-muted-foreground">{pending.toolName}</span>
						</div>
						<p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{pending.reason}</p>
						{args && args !== "{}" ? (
							<pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-muted/50 px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-foreground/75 whitespace-pre-wrap break-words">
								{args.slice(0, 2000)}
							</pre>
						) : null}
						<div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
							<button
								type="button"
								onClick={() => onAnswer("deny")}
								className="h-8 rounded-lg px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								拒绝
							</button>
							<button
								type="button"
								onClick={() => onAnswer("allow_session")}
								className="h-8 rounded-lg border border-border px-2.5 text-[12px] text-foreground transition-colors hover:bg-accent"
							>
								本次会话允许
							</button>
							<button
								type="button"
								onClick={() => onAnswer("allow")}
								className="h-8 rounded-lg bg-foreground px-3 text-[12px] font-medium text-background transition-opacity hover:opacity-85"
							>
								允许
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
