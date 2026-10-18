"use client";

import { Check, ChevronDown, Cpu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export function ModelPicker({
	models,
	provider,
	onChange,
	onConfigure,
	compact,
}: {
	models: ModelInfo[];
	provider: string;
	onChange: (provider: string) => void;
	onConfigure: () => void;
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const current = models.find((model) => model.provider === provider) ?? models[0];

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [open]);

	if (models.length === 0) {
		return (
			<button
				type="button"
				onClick={onConfigure}
				className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<Cpu className="size-3.5" />
				{t("配置模型")}
			</button>
		);
	}

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className={cn(
					"inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-full px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
					open && "bg-accent text-foreground",
					compact && "max-w-[150px]",
				)}
			>
				<Cpu className="size-3.5 shrink-0" strokeWidth={1.75} />
				<span className="min-w-0 truncate">{current?.model ?? t("选择模型")}</span>
				<ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
			</button>
			{open ? (
				<div className="absolute bottom-full left-0 z-50 mb-1.5 w-[280px] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg max-md:bottom-0 max-md:left-0 max-md:mb-10">
					<div className="max-h-72 overflow-y-auto">
						{models.map((model) => (
							<button
								key={model.provider}
								type="button"
								onClick={() => {
									onChange(model.provider);
									setOpen(false);
								}}
								className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
							>
								<span className="mt-0.5 grid size-4 shrink-0 place-items-center">
									{model.provider === provider ? <Check className="size-3.5 text-brand" /> : null}
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[12.5px] text-foreground">{model.model}</span>
									<span className="block truncate text-[10.5px] text-muted-foreground">
										{model.provider} · {model.provider_type}
									</span>
								</span>
							</button>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}
