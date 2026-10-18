"use client";

import { Menu, Plus } from "lucide-react";
import { IconButton } from "@/components/icon-button";
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
		<header className="sticky top-0 z-30 flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center px-1.5 pt-[env(safe-area-inset-top)] md:hidden">
			<IconButton label={t("打开导航")} onClick={onOpenMenu} className="size-10">
				<Menu className="size-5" strokeWidth={1.75} />
			</IconButton>
			<div className="min-w-0 flex-1 truncate px-2 text-center text-[15px] font-medium text-foreground">
				{title}
			</div>
			<IconButton label={t("新建会话")} onClick={onNew} className="size-10">
				<Plus className="size-5" strokeWidth={1.75} />
			</IconButton>
		</header>
	);
}
