import os from "node:os";
import path from "node:path";
import { formatCommandUsage } from "./help.js";
import { getThreadNormalizedTitle } from "./thread-display.js";
import type { ThreadSummary } from "./types.js";

export type ParsedThreadSelectionArgs = {
  includeAll: boolean;
  listProjects: boolean;
  startNew: boolean;
  cwd?: string;
  query: string;
  error?: string;
};

export type ThreadSelectionResult =
  | { kind: "none" }
  | { kind: "unique"; thread: ThreadSummary }
  | { kind: "ambiguous"; threads: ThreadSummary[] };

function normalizeOptionDashes(text: string): string {
  return text
    .replace(/(^|\s)[\u2010-\u2015\u2212](?=\S)/g, "$1--")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
}

export function expandHomeDir(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function parseThreadSelectionArgs(args: string): ParsedThreadSelectionArgs {
  const tokens = normalizeOptionDashes(args)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  let includeAll = false;
  let listProjects = false;
  let startNew = false;
  let cwd: string | undefined;
  let error: string | undefined;
  const queryTokens: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--all" || token === "-a") {
      includeAll = true;
      continue;
    }
    if (token === "--projects" || token === "--project" || token === "-p") {
      listProjects = true;
      continue;
    }
    if (token === "--new") {
      startNew = true;
      continue;
    }
    if (token === "--cwd") {
      const next = tokens[index + 1]?.trim();
      if (!next) {
        error = formatCommandUsage("codex_start");
        break;
      }
      cwd = expandHomeDir(next);
      index += 1;
      continue;
    }
    queryTokens.push(token);
  }

  return {
    includeAll,
    listProjects,
    startNew,
    cwd,
    query: queryTokens.join(" ").trim(),
    error,
  };
}

export function selectThreadFromMatches(
  threads: ThreadSummary[],
  query: string,
): ThreadSelectionResult {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { kind: "none" };
  }
  const lowered = trimmedQuery.toLowerCase();
  const exact =
    threads.find((thread) => thread.threadId === trimmedQuery) ??
    threads.find((thread) => getThreadNormalizedTitle(thread).toLowerCase() === lowered);
  if (exact) {
    return { kind: "unique", thread: exact };
  }
  if (threads.length === 1) {
    return { kind: "unique", thread: threads[0] };
  }
  if (threads.length === 0) {
    return { kind: "none" };
  }
  return { kind: "ambiguous", threads };
}
