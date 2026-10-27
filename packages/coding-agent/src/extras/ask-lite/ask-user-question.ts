import type { ModuleApi } from "@nanopi/pi-coding-agent";
import { loadConfig, validateGuidanceFields } from "./config.js";
import { ASK_USER_PROMPT_EVENT, type AskUserPromptEventPayload } from "./events.js";
import { displayLabel } from "./state/i18n-bridge.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionAnswer,
	type QuestionData,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

function emitAskUserPromptEvent(pi: ModuleApi, params: QuestionParams): void {
	const payload: AskUserPromptEventPayload = {
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

/**
 * Route the questionnaire through the extra module's webui bridge.
 *
 * Returns undefined when the bridge is absent (build flavor without the extra
 * module) or the request was dropped, so the caller falls back to its own
 * no-UI error. The bridge answers in the webui's flat `selected`/`text` shape,
 * which is mapped back onto this tool's `QuestionAnswer` contract.
 */
async function askViaWebuiBridge(params: QuestionParams): Promise<QuestionnaireResult | undefined> {
	// Lazy: packages/extra is a separate build unit, and a flavor may alias it to
	// an inert stub that exports no bridge.
	const { extraBridge } = await import("@nanopi/pi-extra");
	if (!extraBridge.available) return undefined;

	const questions = params.questions.map((q) => ({
		header: q.header,
		question: q.question,
		mode: (q.multiSelect ? "multiple" : q.options.length === 0 ? "text" : "single") as
			| "single"
			| "multiple"
			| "text",
		options: q.options.map((o) => ({ label: o.label, description: o.description })),
	}));

	const resolution = await extraBridge.asks.ask(questions);
	if (!resolution) return undefined;

	const bodies = resolution.type === "batch" ? resolution.answers : [resolution.answer];
	const answers: QuestionAnswer[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const body = bodies[i];
		if (!body || body.declined) continue;
		const question = params.questions[i];
		if (body.selected.length === 0 && body.text === null) continue;
		if (body.selected.length === 0) {
			answers.push({ questionIndex: i, question: question.question, kind: "custom", answer: body.text });
			continue;
		}
		if (question.multiSelect) {
			answers.push({
				questionIndex: i,
				question: question.question,
				kind: "multi",
				answer: null,
				selected: body.selected,
			});
			continue;
		}
		answers.push({
			questionIndex: i,
			question: question.question,
			kind: "option",
			answer: body.selected[0],
		});
	}

	return { answers, cancelled: answers.length === 0 };
}

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	const hasAnyPreview = question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
	for (const kind of sentinelsToAppend(question, hasAnyPreview)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
/*
 * The declaration and this rule used to spell the same call shape twice (counts,
 * option fields, previews, recommended-first). The declaration keeps the shape so
 * it is there when the model builds the call; the rule keeps only the decision of
 * when to stop guessing, which is what the model has to weigh against asking in
 * prose.
 */
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Ask instead of guessing when the request is underspecified and the answer changes what you build; one call carries every open question, with your recommended option first and "(Recommended)" on it.`,
];

export function registerAskUserQuestionTool(pi: ModuleApi): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: `Ask the user 1-${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each, options may carry markdown previews, multiSelect allows several answers) when requirements are ambiguous; group all questions into one call.`,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionParams;

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			// Emit event for external listeners (e.g., notification plugins)
			emitAskUserPromptEvent(pi, typed);

			// No dialog UI (webui, print, rpc): the webui server renders the same
			// questionnaire as a composer card and answers through the bridge.
			if (!ctx.hasUI || ctx.ui.custom === undefined) {
				const bridged = await askViaWebuiBridge(typed);
				if (bridged) return buildQuestionnaireResponse(bridged, typed);
				return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
			}

			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

			// Lazy — QuestionnaireSession pulls the ~560ms view/TUI render graph;
			// load it only when the tool runs, not at extension registration.
			const { QuestionnaireSession } = await import("./state/questionnaire-session.js");

			const result = await ctx.ui.custom<QuestionnaireResult>(
				(tui, theme, _kb, done) => {
					const session = new QuestionnaireSession({
						tui,
						theme,
						params: typed,
						itemsByTab,
						done,
					});
					return session.component;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						maxHeight: "100%",
						margin: { left: 0, right: 0, bottom: 0 },
					},
				},
			);

			return buildQuestionnaireResponse(result, typed);
		},
	});
}

export { buildQuestionnaireResponse, buildToolResult };
