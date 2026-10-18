"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { pairWithCode } from "@/lib/api";
import { t } from "@/lib/i18n";

export function AuthGate() {
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!code.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			await pairWithCode(code.trim());
			window.location.reload();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	return (
		<div className="grid min-h-dvh place-items-center bg-background px-4">
			<form
				onSubmit={submit}
				className="w-full max-w-[360px] rounded-2xl border border-border bg-card p-5 shadow-lg"
			>
				<Logo size={36} />
				<h1 className="mt-4 text-[18px] font-semibold tracking-[-0.02em] text-foreground">
					{t("配对这台设备")}
				</h1>
				<p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">
					{t("在运行")} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">nanopi webui</code>{" "}
					{t("的终端里找到配对码。")}
				</p>
				<input
					autoFocus
					value={code}
					onChange={(event) => setCode(event.target.value)}
					placeholder={t("配对码")}
					autoComplete="one-time-code"
					spellCheck={false}
					className="mt-4 h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-[14px] tracking-[0.08em] text-foreground outline-none placeholder:tracking-normal placeholder:text-muted-foreground focus:border-foreground/30"
				/>
				{error ? <p className="mt-2 text-[11.5px] text-destructive">{error}</p> : null}
				<button
					type="submit"
					disabled={!code.trim() || busy}
					className="mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-foreground text-[12.5px] font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-40"
				>
					{busy ? t("正在连接…") : t("连接")}
					<ArrowRight className="size-3.5" />
				</button>
			</form>
		</div>
	);
}
