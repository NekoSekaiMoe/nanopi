import type {
  ModuleApi,
  ModuleCommandContext,
} from "@nanopi/pi-coding-agent";
import { handleSimplifyCommand, COMMAND_NAME } from "./simplify-command.js";

export default function (pi: ModuleApi): void {
  pi.registerCommand(COMMAND_NAME, {
    description:
      "Review recently changed code for clarity, consistency, and maintainability improvements",
    handler: (args: string, ctx: ModuleCommandContext) =>
      handleSimplifyCommand(args, ctx, pi),
  });
}
