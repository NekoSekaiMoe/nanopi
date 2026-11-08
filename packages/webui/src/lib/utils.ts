import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { getLocale, t } from "@/lib/i18n";

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
	if (getLocale() === "en") {
		if (diff < minute) return "just now";
		if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
		if (diff < day) return `${Math.floor(diff / hour)}h ago`;
		if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
		if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
		return `${Math.floor(diff / (365 * day))}y ago`;
	}
	if (diff < minute) return t("刚刚");
	if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
	if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
	if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
	if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} 个月前`;
	return `${Math.floor(diff / (365 * day))} 年前`;
}

export function timeOfDay(timestamp: number): string {
	return new Date(asMs(timestamp)).toLocaleTimeString(getLocale() === "en" ? "en-US" : "zh-CN", {
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

/** Token counts as the usage readouts print them: 950, 1.2k, 37k, 1.4M. */
export function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Wall-clock duration of a turn, in the coarsest unit that still says something. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Money at the precision that stays readable: whole cents above a dollar, and
 * the four decimals that a single turn costs below it.
 */
export function formatCost(usd: number): string {
	if (usd <= 0) return "$0";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

/**
 * Share of the prompt a cache served. Cache writes are not hits: they are the
 * part that had to be written before it could be read again.
 */
export function cacheHitRate(usage: { context: number; cache_read: number }): number | null {
	if (usage.context <= 0) return null;
	return Math.min(1, usage.cache_read / usage.context);
}
