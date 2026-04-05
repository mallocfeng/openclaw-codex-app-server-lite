import type { CommandName } from "./commands.js";

const HELP: Record<CommandName, string> = {
  codex_start:
    "Usage: /codex_start [--projects|-p] [--new [project]] [--all|-a] [--cwd <path>] [filter]",
  codex_stop: "Usage: /codex_stop",
};

export function formatCommandUsage(command: CommandName): string {
  return HELP[command];
}
