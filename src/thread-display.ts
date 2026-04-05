import type { ThreadSummary } from "./types.js";

const DISPLAY_THREAD_TITLE_MAX_LENGTH = 80;

function normalizeThreadText(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return undefined;
  }
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function truncateThreadText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

export function getThreadNormalizedTitle(
  thread: Pick<ThreadSummary, "threadId" | "title" | "summary">,
): string {
  return normalizeThreadText(thread.title) || normalizeThreadText(thread.summary) || thread.threadId;
}

export function getThreadDisplayTitle(
  thread: Pick<ThreadSummary, "threadId" | "title" | "summary">,
  maxLength = DISPLAY_THREAD_TITLE_MAX_LENGTH,
): string {
  return truncateThreadText(getThreadNormalizedTitle(thread), maxLength);
}
