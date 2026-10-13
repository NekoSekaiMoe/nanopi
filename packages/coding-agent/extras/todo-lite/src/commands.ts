/**
 * /todos 命令注册 — 进入 TodoListComponent TUI 视图（双列布局）。
 *
 * todo-context 消息不再需要 registerMessageRenderer，
 * 因为所有 context 通过 before_agent_start 的 display:false 注入，
 * 用户在 TUI 中不可见。
 */

import type { ModuleApi, ModuleCommandContext, KeybindingsManager, Theme } from "@nanopi/pi-coding-agent";
import type { TUI } from "@nanopi/pi-tui";

import type { TodoSessionState } from "./state.ts";
import { TodoListComponent } from "./component.ts";

/** 注册 /todos 命令到 pi */
export function registerTodosCommand(pi: ModuleApi, state: TodoSessionState): void {
	pi.registerCommand("todos", {
		description: "View all todos for the current branch",
		handler: async (_args: string | undefined, ctx: ModuleCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			// ctx.ui.custom 的 factory 签名为
			//   (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result) => void)
			// 返回 Component & { dispose?(): void }。TodoListComponent 实现该形状，
			// done 接收 result（此处忽略）。
			await ctx.ui.custom((_tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (result: unknown) => void) => {
				return new TodoListComponent(state.todos, theme, () => done(undefined));
			});
		},
	});
}
