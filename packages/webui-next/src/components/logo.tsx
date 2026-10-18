import { cn } from "@/lib/utils";

export function Logo({ className, size = 28 }: { className?: string; size?: number }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-[9px] bg-foreground text-background",
				className,
			)}
			style={{ width: size, height: size }}
			aria-hidden="true"
		>
			<svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none">
				<path
					d="M5 18V6l7 8V6l7 12"
					stroke="currentColor"
					strokeWidth="2.4"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</span>
	);
}
