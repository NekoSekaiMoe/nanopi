import { cn } from "@/lib/utils";

/**
 * The app mark: the shared icon artwork (`favicon.png` / `icon-*.png`), so the
 * in-app logo, the browser tab and the installed app are one image. A plain
 * <img> rather than `next/image`: the export is unoptimized anyway.
 */
export function Logo({ className, size = 28 }: { className?: string; size?: number }) {
	return (
		<img
			src="/favicon.png"
			alt=""
			aria-hidden="true"
			className={cn("shrink-0 rounded-[22%]", className)}
			style={{ width: size, height: size }}
		/>
	);
}
