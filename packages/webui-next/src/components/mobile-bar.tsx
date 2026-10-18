"use client";

import { Menu, Plus } from "lucide-react";
import { IconButton } from "@/components/icon-button";

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
		<header className="sticky top-0 z-30 flex h-[calc(2.75rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b border-border bg-background px-1.5 pt-[env(safe-area-inset-top)] md:hidden">
			<IconButton label="打开导航" onClick={onOpenMenu}>
				<Menu className="size-[18px]" strokeWidth={1.75} />
			</IconButton>
			<div className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-foreground">
				{title}
			</div>
			<IconButton label="新建会话" onClick={onNew}>
				<Plus className="size-[18px]" strokeWidth={1.75} />
			</IconButton>
		</header>
	);
}
