"use client";

import { cn } from "@/lib/utils";

export function IconButton({
	label,
	onClick,
	children,
	className,
	disabled,
	active,
}: {
	label: string;
	onClick?: () => void;
	children: React.ReactNode;
	className?: string;
	disabled?: boolean;
	active?: boolean;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors",
				"hover:bg-sidebar-accent hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
				active && "bg-sidebar-accent text-foreground",
				disabled && "pointer-events-none opacity-40",
				className,
			)}
		>
			{children}
		</button>
	);
}
