export const COMMANDS = [
  [
    "codex_start",
    "Resume a Codex thread, browse projects/threads, or create a new thread in a project.",
  ],
  ["codex_stop", "Detach this Telegram conversation from the current Codex thread."],
] as const;

export type CommandName = (typeof COMMANDS)[number][0];
