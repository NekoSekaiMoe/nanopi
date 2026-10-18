import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

export function asMs(timestamp: number): number {
	return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
	const diff = Math.max(0, now - asMs(timestamp));
	const minute = 60_000;
	const hour = 3_600_000;
	const day = 86_400_000;
	if (diff < minute) return "刚刚";
	if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
	if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
	if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
	if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} 个月前`;
	return `${Math.floor(diff / (365 * day))} 年前`;
}

export function timeOfDay(timestamp: number): string {
	return new Date(asMs(timestamp)).toLocaleTimeString("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function randomId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function shortId(id: string): string {
	return id.slice(0, 8);
}

export function readImageFile(file: File): Promise<{ media_type: string; data: string }> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result ?? "");
			const comma = result.indexOf(",");
			if (comma < 0) {
				reject(new Error("could not read image"));
				return;
			}
			resolve({
				media_type: file.type || "image/png",
				data: result.slice(comma + 1),
			});
		};
		reader.onerror = () => reject(reader.error ?? new Error("could not read image"));
		reader.readAsDataURL(file);
	});
}
