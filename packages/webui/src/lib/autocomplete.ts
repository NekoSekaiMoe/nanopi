// Intelligent AI prompt autocomplete and association library for nanopi webui.

export interface CompletionResult {
	prefix: string;
	suggestion: string;
	full: string;
	category?: string;
}

const SLASH_COMMANDS: readonly string[] = [
	"/help",
	"/clear",
	"/compact",
	"/plan",
	"/model",
	"/status",
	"/settings",
	"/review",
	"/test",
	"/fix",
	"/doc",
	"/skill",
];

const PROMPT_SUGGESTIONS: readonly string[] = [
	"云端电脑的配置是什么？",
	"分析系统硬件规格与操作系统详细信息",
	"解释一下这个项目的结构和运行流程",
	"为当前代码补充单元测试和边界用例",
	"找到并修复当前代码中潜在的 bug",
	"重构这段代码以提高性能和可读性",
	"查看当前 Git 变更并生成结构化的提交信息",
	"帮我分析一下项目依赖和可能的版本冲突",
	"优化数据库查询和异步任务执行效率",
	"检查代码中的安全隐患和异常处理缺陷",
	"编写一个函数用于自动化测试和持续集成",
	"帮我实现一个高效的缓存淘汰策略",
	"分析当前应用的内存占用和性能瓶颈",
	"生成此模块的 API 文档与调用示例",
	"explain the directory structure and main architecture",
	"write comprehensive unit tests covering edge cases",
	"find and fix potential bugs and performance bottlenecks",
	"refactor this module to improve readability and performance",
	"what is the specification and hardware configuration of this computer?",
];

/**
 * Returns an AI completion suggestion if the input matches a known prefix.
 * If matched, `suggestion` is the suffix that will be appended when user presses Tab.
 */
export function getAiSuggestion(input: string): CompletionResult | null {
	const trimmed = input.trimStart();
	if (!trimmed) return null;

	// Slash commands matching
	if (trimmed.startsWith("/")) {
		const match = SLASH_COMMANDS.find((cmd) => cmd.startsWith(trimmed) && cmd !== trimmed);
		if (match) {
			return {
				prefix: input,
				suggestion: match.slice(trimmed.length),
				full: input + match.slice(trimmed.length),
				category: "command",
			};
		}
	}

	const lower = trimmed.toLowerCase();

	// Match against prompt suggestions
	for (const prompt of PROMPT_SUGGESTIONS) {
		const promptLower = prompt.toLowerCase();
		if (promptLower.startsWith(lower) && prompt.length > trimmed.length) {
			const suffix = prompt.slice(trimmed.length);
			return {
				prefix: input,
				suggestion: suffix,
				full: input + suffix,
				category: "prompt",
			};
		}
	}

	// Partial word boundary matching (e.g. user typed "配置" -> "云端电脑的配置是什么？")
	if (trimmed.length >= 2) {
		for (const prompt of PROMPT_SUGGESTIONS) {
			const index = prompt.indexOf(trimmed);
			if (index > 0) {
				const suffix = prompt.slice(index + trimmed.length);
				if (suffix.length > 0) {
					return {
						prefix: input,
						suggestion: suffix,
						full: input + suffix,
						category: "prompt",
					};
				}
			}
		}
	}

	return null;
}
