"use client";

import { Menu, Plus } from "lucide-react";
import { t } from "@/lib/i18n";

export function MobileBar({
	title,
	onOpenMenu,
	onNew,
}: {
	title: string;
	onOpenMenu: () => void;
	onNew: () => void;
}) {
	return (
		<header className="sticky top-0 z-30 flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center justify-between px-3 pt-[env(safe-area-inset-top)] bg-[#000000] border-b border-white/[0.05]">
			<button
				type="button"
				aria-label={t("打开导航")}
				onClick={onOpenMenu}
				className="grid size-10 place-items-center rounded-lg text-foreground hover:bg-white/[0.06]"
			>
				<Menu className="size-5" strokeWidth={2} />
			</button>
			<div className="min-w-0 flex-1 truncate px-2 text-center text-[16px] font-medium text-foreground">
				{title}
			</div>
			<button
				type="button"
				aria-label={t("新建会话")}
				onClick={onNew}
				className="grid size-10 place-items-center rounded-lg text-foreground hover:bg-white/[0.06]"
			>
				<Plus className="size-5" strokeWidth={2} />
			</button>
		</header>
	);
}
