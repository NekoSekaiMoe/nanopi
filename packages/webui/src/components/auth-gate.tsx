"use client";

import { Logo } from "@/components/logo";
import { t } from "@/lib/i18n";

/**
 * Shown when the page was opened without the tokenised link the terminal
 * printed: a second browser, a bookmark, or after the tab's sessionStorage was
 * cleared. Every request would be refused, and an empty app reads as the
 * service being down.
 */
export function AuthGate() {
	return (
		<div className="grid min-h-dvh place-items-center bg-background px-4">
			<div className="w-full max-w-[420px] rounded-2xl border border-border bg-card p-5">
				<Logo size={36} />
				<h1 className="mt-4 text-heading font-semibold tracking-[-0.02em] text-foreground">
					{t("需要从终端打开")}
				</h1>
				<p className="mt-2 text-label leading-6 text-muted-foreground">
					{t("这个页面需要终端给出的链接才能访问。请在终端运行")}{" "}
					<code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
						nanopi webui
					</code>
					{t("，复制它打印的那条带 token 的链接，粘贴到这个浏览器的地址栏打开。")}
				</p>
				<p className="mt-3 border-t border-border pt-3 text-caption leading-5 text-muted-foreground">
					{t("这条链接在本次 webui 运行期间可以在任意浏览器使用；webui 重启后需要重新获取。")}
				</p>
			</div>
		</div>
	);
}
