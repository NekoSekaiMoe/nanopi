"use client";

import { ArrowLeft, Menu, Plus } from "lucide-react";
import { IconButton } from "@/components/icon-button";
import { t } from "@/lib/i18n";

/**
 * Phone header. `back` is set while a pane (file, terminal) replaces the chat:
 * the leading button then returns to the chat instead of opening the drawer,
 * and the drawer moves to the trailing slot, which is where a full-screen pane
 * still needs it (to switch files or sessions).
 */
export function MobileBar({
	title,
	onOpenMenu,
	onNew,
	back,
}: {
	title: string;
	onOpenMenu: () => void;
	onNew: () => void;
	back?: { label: string; onBack: () => void };
}) {
	return (
		<header className="sticky top-0 z-30 flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center bg-sidebar px-1.5 pt-[env(safe-area-inset-top)] md:hidden">
			{back ? (
				<IconButton label={back.label} onClick={back.onBack} className="size-10">
					<ArrowLeft className="size-5" strokeWidth={1.75} />
				</IconButton>
			) : (
				<IconButton label={t("打开导航")} onClick={onOpenMenu} className="size-10">
					<Menu className="size-5" strokeWidth={1.75} />
				</IconButton>
			)}
			<div className="min-w-0 flex-1 truncate px-2 text-center text-control font-medium text-foreground">
				{title}
			</div>
			{back ? (
				<IconButton label={t("打开导航")} onClick={onOpenMenu} className="size-10">
					<Menu className="size-5" strokeWidth={1.75} />
				</IconButton>
			) : (
				<IconButton label={t("新建会话")} onClick={onNew} className="size-10">
					<Plus className="size-5" strokeWidth={1.75} />
				</IconButton>
			)}
		</header>
	);
}
