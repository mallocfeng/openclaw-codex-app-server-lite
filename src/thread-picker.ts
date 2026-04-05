import path from "node:path";
import type { ThreadSummary } from "./types.js";

export const THREAD_PICKER_PAGE_SIZE = 8;

export type ProjectSummary = {
  name: string;
  threadCount: number;
  latestUpdatedAt?: number;
};

export function getProjectName(projectKey?: string): string | undefined {
  const trimmed = projectKey?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const base = path.basename(normalized);
  return base || undefined;
}

export function filterThreadsByProjectName(
  threads: ThreadSummary[],
  projectName?: string,
): ThreadSummary[] {
  const normalized = projectName?.trim().toLowerCase();
  if (!normalized) {
    return [...threads];
  }
  return threads.filter((thread) => getProjectName(thread.projectKey)?.toLowerCase() === normalized);
}

export function listProjects(
  threads: ThreadSummary[],
  query = "",
): ProjectSummary[] {
  const filteredQuery = query.trim().toLowerCase();
  const grouped = new Map<string, ProjectSummary>();

  for (const thread of threads) {
    const projectName = getProjectName(thread.projectKey);
    if (!projectName) {
      continue;
    }
    if (filteredQuery && !projectName.toLowerCase().includes(filteredQuery)) {
      continue;
    }
    const existing = grouped.get(projectName);
    const updatedAt = thread.updatedAt ?? thread.createdAt;
    if (!existing) {
      grouped.set(projectName, {
        name: projectName,
        threadCount: 1,
        latestUpdatedAt: updatedAt,
      });
      continue;
    }
    existing.threadCount += 1;
    existing.latestUpdatedAt = Math.max(existing.latestUpdatedAt ?? 0, updatedAt ?? 0) || undefined;
  }

  return [...grouped.values()].sort((left, right) => {
    const updatedDelta = (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return left.name.localeCompare(right.name);
  });
}

export function paginateItems<T>(
  items: T[],
  page: number,
  pageSize = THREAD_PICKER_PAGE_SIZE,
): {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
} {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = safePage * pageSize;
  const pageItems = items.slice(startIndex, startIndex + pageSize);
  return {
    items: pageItems,
    page: safePage,
    pageSize,
    totalItems,
    totalPages,
    startIndex,
    endIndex: startIndex + pageItems.length,
  };
}
