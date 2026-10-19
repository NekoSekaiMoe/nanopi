"use client";

import { useState } from "react";
import type { UserInputRequestEvent, UserInputResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

interface Answer {
	declined: boolean;
	selected: string[];
	text: string | null;
}

export function UserInputCard({
	request,
	onAnswer,
}: {
	request: UserInputRequestEvent;
	onAnswer: (answer: UserInputResponse) => void;
}) {
	const questions =
		request.questions && request.questions.length > 0
			? request.questions
			: [
					{
						header: request.header,
						question: request.question,
						mode: request.mode,
						options: request.options,
						custom: request.custom,
					},
				];

	const [answers, setAnswers] = useState<Answer[]>(
		questions.map(() => ({ declined: false, selected: [], text: null })),
	);

	function update(index: number, patch: Partial<Answer>) {
		setAnswers((current) =>
			current.map((answer, cursor) => (cursor === index ? { ...answer, ...patch } : answer)),
		);
	}

	const ready = answers.every((answer, index) => {
		const question = questions[index];
		return answer.selected.length > 0 || Boolean(answer.text?.trim()) || question.mode === "text";
	});

	return (
		<div className="mx-auto w-full max-w-[840px] px-4 pb-2 sm:px-6 lg:px-10">
			<div className="rounded-2xl border border-brand-border bg-brand-soft p-3.5">
				<div className="space-y-3">
					{questions.map((question, index) => (
						<div key={index}>
							<div className="flex items-baseline gap-2">
								<span className="text-caption font-medium uppercase tracking-[0.06em] text-brand">
									{question.header || t("需要你的输入")}
								</span>
								{questions.length > 1 ? (
									<span className="text-caption text-muted-foreground">
										{index + 1}/{questions.length}
									</span>
								) : null}
							</div>
							<p className="mt-0.5 text-control leading-5 text-foreground">{question.question}</p>
							{question.options.length > 0 ? (
								<div className="mt-2 flex flex-wrap gap-1.5">
									{question.options.map((option) => {
										const selected = answers[index]?.selected.includes(option.label);
										return (
											<button
												key={option.label}
												type="button"
												title={option.description}
												onClick={() => {
													if (question.mode === "multiple") {
														const current = answers[index]?.selected ?? [];
														update(index, {
															selected: selected
																? current.filter((label) => label !== option.label)
																: [...current, option.label],
														});
													} else {
														update(index, { selected: [option.label], text: null });
													}
												}}
												className={cn(
													"rounded-full border px-2.5 py-1 text-[12px] transition-colors",
													selected
														? "border-brand bg-brand text-brand-foreground"
														: "border-border bg-background text-foreground hover:bg-overlay-hover",
												)}
											>
												{option.label}
											</button>
										);
									})}
								</div>
							) : null}
							{question.mode === "text" || question.custom !== false ? (
								<input
									value={answers[index]?.text ?? ""}
									onChange={(event) => update(index, { text: event.target.value })}
									placeholder={question.mode === "text" ? t("输入回答") : t("或输入自定义回答")}
									className="mt-2 h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/25"
								/>
							) : null}
						</div>
					))}
				</div>
				<div className="mt-3 flex items-center justify-end gap-1.5">
					<button
						type="button"
						onClick={() => onAnswer({ declined: true, selected: [], text: null })}
						className="h-8 rounded-lg px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-overlay-hover hover:text-foreground"
					>
						{t("跳过")}
					</button>
					<button
						type="button"
						disabled={!ready}
						onClick={() =>
							onAnswer(
								answers.length === 1
									? answers[0]
									: { responses: answers },
							)
						}
						className={cn(
							"h-8 rounded-lg px-3 text-[12px] font-medium transition-opacity",
							ready
								? "bg-foreground text-background hover:opacity-85"
								: "bg-muted text-muted-foreground",
						)}
					>
						{t("提交")}
					</button>
				</div>
			</div>
		</div>
	);
}
