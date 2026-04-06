import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginCommandContext,
  PluginConversationBindingResolvedEvent,
  PluginInboundMedia,
  PluginInteractiveButtons,
  PluginInteractiveTelegramHandlerContext,
  ReplyPayload,
  ConversationRef,
} from "openclaw/plugin-sdk";
import {
  detachPluginConversationBinding,
  isSessionBindingError,
  parsePluginBindingApprovalCustomId,
  requestPluginConversationBinding,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { parseFeishuConversationId } from "openclaw/plugin-sdk/feishu-conversation";
import { CodexAppServerModeClient, type ActiveCodexRun, isMissingThreadError } from "./client.js";
import { COMMANDS, type CommandName } from "./commands.js";
import { resolvePluginSettings, resolveWorkspaceDir } from "./config.js";
import { getThreadDisplayTitle, getThreadNormalizedTitle } from "./thread-display.js";
import { formatCommandUsage } from "./help.js";
import { buildConversationKey, buildPluginSessionKey, PluginStateStore } from "./state.js";
import { parseThreadSelectionArgs, selectThreadFromMatches } from "./thread-selection.js";
import { filterThreadsByProjectName, listProjects, paginateItems } from "./thread-picker.js";
import {
  INTERACTIVE_NAMESPACE,
  PLUGIN_ID,
  type CallbackAction,
  type AccountSummary,
  CALLBACK_TTL_MS,
  type CodexTurnInputItem,
  type ConversationTarget,
  type PendingInputState,
  type StoredTextMenuOption,
  type StoredBinding,
  type StoredPendingBind,
  type ThreadSummary,
  type TurnTerminalError,
  type TurnResult,
} from "./types.js";

type ScopedBindingApi = {
  requestConversationBinding?: (
    params?: { summary?: string },
  ) => Promise<
    | { status: "bound" }
    | { status: "pending"; reply: ReplyPayload }
    | { status: "error"; message: string }
  >;
  detachConversationBinding?: () => Promise<{ removed: boolean }>;
};

type ActiveRunRecord = {
  conversation: ConversationTarget;
  handle: ActiveCodexRun;
  binding: StoredBinding;
};

type TelegramOutboundAdapter = {
  sendText?: (ctx: {
    cfg: unknown;
    to: string;
    text: string;
    accountId?: string;
    threadId?: string | number;
  }) => Promise<{ messageId: string; chatId?: string }>;
  sendPayload?: (ctx: {
    cfg: unknown;
    to: string;
    payload: ReplyPayload;
    accountId?: string;
    threadId?: string | number;
  }) => Promise<{ messageId: string; chatId?: string }>;
};

type OutboundAdapter = TelegramOutboundAdapter;

type BeforeDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  senderId?: string;
};

type BeforeDispatchContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  senderId?: string;
};

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type PickerRender = {
  text: string;
  buttons?: PluginInteractiveButtons;
};

type WorkspaceChoice = {
  workspaceDir: string;
  latestUpdatedAt?: number;
};

type ProjectPickerView = Extract<CallbackAction, { kind: "picker-view" }>["view"] & {
  mode: "projects";
};

type ThreadPickerView = Extract<CallbackAction, { kind: "picker-view" }>["view"] & {
  mode: "threads";
};

type WorkspacePickerView = Extract<CallbackAction, { kind: "picker-view" }>["view"] & {
  mode: "workspaces";
};

const TELEGRAM_TEXT_LIMIT = 4000;
const TEXT_ATTACHMENT_FILE_EXTENSIONS = new Set([
  ".json",
  ".log",
  ".markdown",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
]);
const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/x-yaml",
  "application/yaml",
  "text/json",
  "text/markdown",
  "text/plain",
  "text/x-markdown",
  "text/yaml",
]);
const MAX_TEXT_ATTACHMENT_BYTES = 64 * 1024;
const MAX_TEXT_ATTACHMENT_CHARS = 16_000;

function asScopedBindingApi(value: object): ScopedBindingApi {
  return value as ScopedBindingApi;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTelegramChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "telegram";
}

function isFeishuChannel(channel: string): boolean {
  const normalized = channel.trim().toLowerCase();
  return normalized === "feishu" || normalized === "lark";
}

function normalizeSupportedChannel(channel: string | undefined): "telegram" | "feishu" | null {
  const normalized = channel?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "telegram") {
    return "telegram";
  }
  if (normalized === "feishu" || normalized === "lark") {
    return "feishu";
  }
  return null;
}

function supportsInteractiveButtons(channel: string): boolean {
  return normalizeSupportedChannel(channel) === "telegram";
}

function getChannelLabel(channel: string): string {
  return normalizeSupportedChannel(channel) === "feishu" ? "Feishu" : "Telegram";
}

function parseLeadingCommand(
  text: string,
): {
  command: CommandName;
  args: string;
} | null {
  const match = text
    .trim()
    .match(/^\/(codex_start|codex_stop)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  const [, rawCommand, rawArgs] = match;
  const command = rawCommand?.toLowerCase() === "codex_stop" ? "codex_stop" : "codex_start";
  return {
    command,
    args: rawArgs?.trim() ?? "",
  };
}

function parseNumericSelection(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeTelegramChatId(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("telegram:") ? trimmed.slice("telegram:".length) : trimmed;
}

function splitTelegramConversationId(conversationId: string): {
  chatId: string;
  threadId?: number;
} {
  const topicMatch = conversationId.match(/^(.*):topic:(\d+)$/);
  if (!topicMatch) {
    return { chatId: conversationId };
  }
  return {
    chatId: topicMatch[1] ?? conversationId,
    threadId: Number.parseInt(topicMatch[2] ?? "", 10),
  };
}

function buildPlainReply(text: string, buttons?: PluginInteractiveButtons): ReplyPayload {
  return buttons
    ? {
        text,
        channelData: {
          telegram: {
            buttons,
          },
        },
      }
    : { text };
}

function buildTextMenuPrompt(text: string, options: StoredTextMenuOption[]): string {
  const lines = [text.trim(), ""];
  for (const [index, option] of options.entries()) {
    lines.push(`${index + 1}. ${option.label}`);
  }
  lines.push("", "Reply with a number to choose.");
  return lines.join("\n");
}

function toTextMenuOptions(buttons: PluginInteractiveButtons): StoredTextMenuOption[] {
  const options: StoredTextMenuOption[] = [];
  for (const row of buttons) {
    for (const button of row) {
      const callbackData = button.callback_data?.trim();
      if (!callbackData) {
        continue;
      }
      const tokenPrefix = `${INTERACTIVE_NAMESPACE}:`;
      if (callbackData.startsWith(tokenPrefix)) {
        options.push({
          kind: "callback",
          label: button.text,
          token: callbackData.slice(tokenPrefix.length),
        });
        continue;
      }
      const approvalAction = parsePluginBindingApprovalCustomId(callbackData);
      if (approvalAction) {
        options.push({
          kind: "binding-approval",
          label: button.text,
          approvalId: approvalAction.approvalId,
          decision: approvalAction.decision,
        });
      }
    }
  }
  return options;
}

function normalizeTextMenuOptionsForChannel(
  channel: string,
  options: StoredTextMenuOption[],
): StoredTextMenuOption[] {
  if (
    channel === "feishu" &&
    options.length > 0 &&
    options.every((option) => option.kind === "binding-approval")
  ) {
    const confirm = options.find(
      (option) => option.kind === "binding-approval" && option.decision === "allow-once",
    );
    const deny = options.find(
      (option) => option.kind === "binding-approval" && option.decision === "deny",
    );
    const normalized: StoredTextMenuOption[] = [];
    if (confirm) {
      normalized.push({ ...confirm, label: "Confirm" });
    }
    if (deny) {
      normalized.push({ ...deny, label: "Cancel" });
    }
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return options;
}

function extractReplyButtons(reply: ReplyPayload): PluginInteractiveButtons | undefined {
  const telegramButtons = asRecord(reply.channelData?.telegram)?.buttons;
  if (Array.isArray(telegramButtons)) {
    return telegramButtons as PluginInteractiveButtons;
  }

  const interactive = asRecord(reply)?.interactive;
  const blocks = Array.isArray(asRecord(interactive)?.blocks)
    ? (asRecord(interactive)?.blocks as unknown[])
    : [];
  const rows: PluginInteractiveButtons = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record || record.type !== "buttons") {
      continue;
    }
    const buttons = Array.isArray(record.buttons) ? record.buttons : [];
    const row: PluginInteractiveButtons[number] = buttons
      .map((button) => {
        const buttonRecord = asRecord(button);
        const text = buttonRecord?.label;
        const callbackData = buttonRecord?.value;
        const style = buttonRecord?.style;
        if (typeof text !== "string" || typeof callbackData !== "string") {
          return null;
        }
        const normalizedStyle: "danger" | "success" | "primary" | undefined =
          style === "danger" || style === "success" || style === "primary" ? style : undefined;
        return {
          text,
          callback_data: callbackData,
          style: normalizedStyle,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    if (row.length > 0) {
      rows.push(row);
    }
  }

  return rows.length > 0 ? rows : undefined;
}

function looksLikePath(value: string): boolean {
  return value.startsWith("~") || value.startsWith(".") || value.includes("/") || value.includes("\\");
}

function chunkText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit / 2) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < limit / 2) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function summarizeText(text: string, maxChars = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function normalizeInboundMediaPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.split(";", 1)[0]?.trim() || undefined;
}

function isImageMimeType(value: string | undefined): boolean {
  return Boolean(normalizeMimeType(value)?.startsWith("image/"));
}

function isImagePathLike(value: string | undefined): boolean {
  const normalized = normalizeInboundMediaPath(value);
  if (!normalized) {
    return false;
  }
  return new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
    ".heic",
    ".heif",
    ".avif",
  ]).has(path.extname(normalized).toLowerCase());
}

function isTextAttachmentMimeType(value: string | undefined): boolean {
  const normalized = normalizeMimeType(value);
  return Boolean(
    normalized &&
      (normalized.startsWith("text/") || TEXT_ATTACHMENT_MIME_TYPES.has(normalized)),
  );
}

function isTextAttachmentPathLike(value: string | undefined): boolean {
  const normalized = normalizeInboundMediaPath(value);
  if (!normalized || /^(https?:|data:|file:)/i.test(normalized)) {
    return false;
  }
  return TEXT_ATTACHMENT_FILE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

async function toCodexTextAttachmentInputItem(
  media: PluginInboundMedia,
): Promise<CodexTurnInputItem | null> {
  if (
    media.kind === "image" ||
    !(
      isTextAttachmentMimeType(media.mimeType) ||
      isTextAttachmentPathLike(media.path) ||
      isTextAttachmentPathLike(media.url)
    )
  ) {
    return null;
  }
  const normalizedPath = normalizeInboundMediaPath(media.path ?? media.url);
  if (!normalizedPath || !path.isAbsolute(normalizedPath)) {
    return null;
  }
  const stats = await fs.stat(normalizedPath).catch(() => undefined);
  if (!stats?.isFile()) {
    return null;
  }
  const bytesToRead = Math.min(stats.size, MAX_TEXT_ATTACHMENT_BYTES);
  const handle = await fs.open(normalizedPath, "r").catch(() => undefined);
  if (!handle) {
    return null;
  }
  let rawContent = "";
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    rawContent = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
  const normalizedContent = rawContent.replace(/\r\n/g, "\n");
  const content =
    normalizedContent.length > MAX_TEXT_ATTACHMENT_CHARS
      ? normalizedContent.slice(0, MAX_TEXT_ATTACHMENT_CHARS)
      : normalizedContent;
  const displayName = media.fileName?.trim() || path.basename(normalizedPath) || "attached-file.txt";
  return {
    type: "text",
    text: `Attached file: ${displayName}\n\n${content.trim() || "[File is empty]"}`,
  };
}

async function buildInboundTurnInput(event: {
  content: string;
  media?: PluginInboundMedia[];
}): Promise<CodexTurnInputItem[]> {
  const items: CodexTurnInputItem[] = [];
  if (event.content.trim()) {
    items.push({ type: "text", text: event.content });
  }
  for (const media of event.media ?? []) {
    if (media.kind === "image" || isImageMimeType(media.mimeType) || isImagePathLike(media.path)) {
      const normalizedPath = normalizeInboundMediaPath(media.path ?? media.url);
      if (normalizedPath && path.isAbsolute(normalizedPath)) {
        items.push({ type: "localImage", path: normalizedPath });
        continue;
      }
      const url = media.url?.trim();
      if (url) {
        items.push({ type: "image", url });
      }
      continue;
    }
    const attachment = await toCodexTextAttachmentInputItem(media);
    if (attachment) {
      items.push(attachment);
    }
  }
  return items;
}

function isQueueCompatibleTurnInput(
  prompt: string,
  input: readonly CodexTurnInputItem[] | undefined,
): boolean {
  if (!input?.length) {
    return true;
  }
  return input.length === 1 && input[0]?.type === "text" && input[0].text === prompt;
}

function normalizeFeishuDirectConversationId(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutProvider = trimmed.replace(/^(feishu|lark):/i, "").trim();
  const directMatch = /^(?:user|dm|open_id):(.+)$/i.exec(withoutProvider);
  const directId = directMatch?.[1]?.trim() ?? withoutProvider;
  if (/^(ou_|on_)/i.test(directId)) {
    return directId;
  }
  return undefined;
}

function normalizeFeishuTargetConversationId(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutProvider = trimmed.replace(/^(feishu|lark):/i, "").trim();
  const targetMatch = /^(?:chat|group|channel|user|dm|open_id):(.+)$/i.exec(withoutProvider);
  const targetId = targetMatch?.[1]?.trim() ?? withoutProvider;
  if (/^(oc_|ou_|on_)/i.test(targetId)) {
    return targetId;
  }
  return undefined;
}

function toConversationTargetFromCommand(ctx: PluginCommandContext): ConversationTarget | null {
  const channel = normalizeSupportedChannel(ctx.channel);
  if (!channel) {
    return null;
  }
  if (channel === "telegram") {
    const chatId = normalizeTelegramChatId(ctx.to ?? ctx.from ?? ctx.senderId);
    if (!chatId) {
      return null;
    }
    const threadId =
      typeof ctx.messageThreadId === "number"
        ? ctx.messageThreadId
        : typeof ctx.messageThreadId === "string" && /^\d+$/.test(ctx.messageThreadId.trim())
          ? Number.parseInt(ctx.messageThreadId.trim(), 10)
          : undefined;
    return {
      channel,
      accountId: ctx.accountId ?? "default",
      conversationId: threadId != null ? `${chatId}:topic:${threadId}` : chatId,
      parentConversationId: threadId != null ? chatId : undefined,
      threadId,
    };
  }
  const threadId =
    typeof ctx.messageThreadId === "string" || typeof ctx.messageThreadId === "number"
      ? ctx.messageThreadId
      : undefined;
  const threadParentId = ctx.threadParentId?.trim();
  if (channel === "feishu") {
    if (threadParentId && threadId != null) {
      return {
        channel,
        accountId: ctx.accountId ?? "default",
        conversationId: `${threadParentId}:topic:${String(threadId)}`,
        parentConversationId: threadParentId,
        threadId,
      };
    }
    if (threadParentId) {
      return {
        channel,
        accountId: ctx.accountId ?? "default",
        conversationId: threadParentId,
        parentConversationId: threadParentId,
      };
    }
  }
  const conversationId = (ctx.to ?? ctx.from ?? ctx.senderId)?.trim();
  if (!conversationId) {
    return null;
  }
  if (channel === "feishu") {
    const normalizedParentConversationId = normalizeFeishuTargetConversationId(threadParentId);
    const directId = normalizeFeishuDirectConversationId(conversationId);
    if (directId) {
      return {
        channel,
        accountId: ctx.accountId ?? "default",
        conversationId: directId,
      };
    }
    const normalizedConversationId = normalizeFeishuTargetConversationId(conversationId);
    if (normalizedConversationId) {
      return {
        channel,
        accountId: ctx.accountId ?? "default",
        conversationId: normalizedConversationId,
        parentConversationId:
          threadId != null && normalizedParentConversationId
            ? normalizedParentConversationId
            : undefined,
        threadId,
      };
    }
    const parsed = parseFeishuConversationId({
      conversationId,
      parentConversationId: normalizedParentConversationId,
    });
    return {
      channel,
      accountId: ctx.accountId ?? "default",
      conversationId: parsed?.canonicalConversationId ?? conversationId,
      parentConversationId: parsed?.chatId ?? normalizedParentConversationId,
      threadId: parsed?.topicId ?? threadId,
    };
  }
  return {
    channel,
    accountId: ctx.accountId ?? "default",
    conversationId,
    threadId,
  };
}

function toConversationTargetFromInbound(event: {
  channel: string;
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  senderId?: string;
  threadId?: string | number;
}): ConversationTarget | null {
  const channel = normalizeSupportedChannel(event.channel);
  const conversationId = event.conversationId?.trim();
  if (!channel || !conversationId) {
    return null;
  }
  if (channel === "telegram") {
    const { chatId, threadId } = splitTelegramConversationId(conversationId);
    return {
      channel,
      accountId: event.accountId ?? "default",
      conversationId,
      parentConversationId: event.parentConversationId ?? (threadId != null ? chatId : undefined),
      threadId: event.threadId ?? threadId,
    };
  }
  const normalizedParentConversationId = normalizeFeishuTargetConversationId(
    event.parentConversationId,
  );
  const directId = normalizeFeishuDirectConversationId(conversationId);
  if (directId) {
    return {
      channel,
      accountId: event.accountId ?? "default",
      conversationId: directId,
    };
  }
  const normalizedConversationId = normalizeFeishuTargetConversationId(conversationId);
  if (normalizedConversationId) {
    return {
      channel,
      accountId: event.accountId ?? "default",
      conversationId: normalizedConversationId,
      parentConversationId:
        event.threadId != null && normalizedParentConversationId
          ? normalizedParentConversationId
          : undefined,
      threadId: event.threadId,
    };
  }
  const parsed = parseFeishuConversationId({
    conversationId,
    parentConversationId: normalizedParentConversationId,
  });
  return {
    channel,
    accountId: event.accountId ?? "default",
    conversationId: parsed?.canonicalConversationId ?? conversationId,
    parentConversationId: parsed?.chatId ?? normalizedParentConversationId,
    threadId: event.threadId ?? parsed?.topicId,
  };
}

function toConversationTargetFromBeforeDispatch(
  event: BeforeDispatchEvent,
  ctx: BeforeDispatchContext,
): ConversationTarget | null {
  const channel = normalizeSupportedChannel(ctx.channelId ?? event.channel);
  const conversationId = ctx.conversationId?.trim();
  if (!channel || !conversationId) {
    return null;
  }
  if (channel === "telegram") {
    const { chatId, threadId } = splitTelegramConversationId(conversationId);
    return {
      channel,
      accountId: ctx.accountId ?? "default",
      conversationId,
      parentConversationId: threadId != null ? chatId : undefined,
      threadId,
    };
  }
  const directId = normalizeFeishuDirectConversationId(conversationId);
  if (directId) {
    return {
      channel,
      accountId: ctx.accountId ?? "default",
      conversationId: directId,
    };
  }
  const normalizedConversationId = normalizeFeishuTargetConversationId(conversationId);
  if (normalizedConversationId) {
    return {
      channel,
      accountId: ctx.accountId ?? "default",
      conversationId: normalizedConversationId,
    };
  }
  const parsed = parseFeishuConversationId({ conversationId });
  return {
    channel,
    accountId: ctx.accountId ?? "default",
    conversationId: parsed?.canonicalConversationId ?? conversationId,
    parentConversationId: parsed?.chatId ?? undefined,
    threadId: parsed?.topicId,
  };
}

function resolveOutboundTarget(conversation: ConversationTarget): {
  to: string;
  threadId?: string | number;
} {
  const channel = normalizeSupportedChannel(conversation.channel);
  if (channel === "telegram") {
    const { chatId, threadId } = splitTelegramConversationId(conversation.conversationId);
    return {
      to: conversation.parentConversationId?.trim() || chatId,
      threadId: conversation.threadId ?? threadId,
    };
  }
  if (channel === "feishu") {
    const parsed = parseFeishuConversationId({
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
    });
    if (parsed) {
      return {
        to: parsed.chatId,
        threadId: conversation.threadId ?? parsed.topicId,
      };
    }
  }
  return {
    to: conversation.parentConversationId?.trim() || conversation.conversationId,
    threadId: conversation.threadId,
  };
}

function formatPendingInputText(state: PendingInputState): string {
  const lines = [state.promptText?.trim() || "Codex needs input to continue."];
  if (state.actions?.length) {
    lines.push("", "Buttons:");
    for (const [index, action] of state.actions.entries()) {
      if (action.kind === "steer") {
        lines.push(`- ${index + 1}. ${action.label} (or send a normal text reply)`);
      } else {
        lines.push(`- ${index + 1}. ${action.label}`);
      }
    }
  } else if (state.options.length > 0) {
    lines.push("", "Reply with text or use a button below.");
  }
  return lines.join("\n");
}

function bindingSuccessText(binding: StoredBinding): string {
  const title = binding.threadTitle?.trim() || binding.threadId;
  return `Bound this ${getChannelLabel(binding.conversation.channel)} conversation to Codex thread:\n- ${title}\n- workspace: ${binding.workspaceDir}`;
}

function listWorkspaceChoices(threads: ThreadSummary[], projectName: string): WorkspaceChoice[] {
  const grouped = new Map<string, WorkspaceChoice>();
  for (const thread of threads) {
    if (!thread.projectKey || !projectName) {
      continue;
    }
    if ((path.basename(thread.projectKey.replace(/[\\/]+$/, "")) || "") !== projectName) {
      continue;
    }
    const existing = grouped.get(thread.projectKey);
    const updatedAt = thread.updatedAt ?? thread.createdAt;
    if (!existing) {
      grouped.set(thread.projectKey, {
        workspaceDir: thread.projectKey,
        latestUpdatedAt: updatedAt,
      });
      continue;
    }
    existing.latestUpdatedAt = Math.max(existing.latestUpdatedAt ?? 0, updatedAt ?? 0) || undefined;
  }
  return [...grouped.values()].sort(
    (left, right) => (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0),
  );
}

export class LiteCodexController {
  private readonly settings;
  private readonly client;
  private readonly store;
  private readonly activeRuns = new Map<string, ActiveRunRecord>();
  private serviceWorkspaceDir?: string;
  private lastRuntimeConfig?: unknown;
  private started = false;

  constructor(private readonly api: OpenClawPluginApi) {
    this.settings = resolvePluginSettings(this.api.pluginConfig);
    this.client = new CodexAppServerModeClient(this.settings, this.api.logger);
    this.store = new PluginStateStore(this.api.runtime.state.resolveStateDir());
  }

  createService(): OpenClawPluginService {
    return {
      id: `${PLUGIN_ID}-service`,
      start: async (ctx) => {
        this.serviceWorkspaceDir = ctx.workspaceDir;
        await this.start();
      },
      stop: async () => {
        await this.stop();
      },
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.store.load();
    await this.client.logStartupProbe().catch(() => undefined);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    for (const active of this.activeRuns.values()) {
      await active.handle.interrupt().catch(() => undefined);
    }
    this.activeRuns.clear();
    await this.client.close().catch(() => undefined);
    this.started = false;
  }

  async handleConversationBindingResolved(
    event: PluginConversationBindingResolvedEvent,
  ): Promise<void> {
    await this.start();
    const channel = normalizeSupportedChannel(event.request.conversation.channel);
    if (!channel) {
      return;
    }
    const conversation: ConversationTarget = {
      channel,
      accountId: event.request.conversation.accountId,
      conversationId: event.request.conversation.conversationId,
      parentConversationId: event.request.conversation.parentConversationId,
      threadId: event.request.conversation.threadId,
    };
    const pending = this.store.getPendingBind(conversation);
    if (!pending) {
      return;
    }
    await this.store.removeTextMenu(conversation);
    if (event.status === "denied") {
      await this.store.removePendingBind(conversation);
      await this.sendText(conversation, "Codex binding approval was denied.");
      return;
    }
    const binding = await this.bindConversation(conversation, pending);
    await this.store.removePendingBind(conversation);
    await this.sendText(conversation, bindingSuccessText(binding));
  }

  async handleCommand(commandName: string, ctx: PluginCommandContext): Promise<ReplyPayload> {
    await this.start();
    this.lastRuntimeConfig = ctx.config;
    const conversation = toConversationTargetFromCommand(ctx);
    if (!conversation) {
      return { text: "This plugin currently supports Telegram and Feishu conversations only." };
    }
    const bindingApi = asScopedBindingApi(ctx);
    const binding =
      this.store.getBinding(conversation) ?? (await this.hydrateApprovedBinding(conversation));
    const args = ctx.args?.trim() ?? "";

    if (commandName === "codex_stop") {
      return { text: await this.detachConversation(conversation, bindingApi.detachConversationBinding) };
    }

    if (args === "--help" || args === "help") {
      return await this.normalizeCommandReply(conversation, {
        text: formatCommandUsage("codex_start"),
      });
    }

    const reply = await this.handleResumeCommand(conversation, binding, args, bindingApi);
    return await this.normalizeCommandReply(conversation, reply);
  }

  async handleBeforeDispatch(
    event: BeforeDispatchEvent,
    ctx: BeforeDispatchContext,
  ): Promise<{ handled: boolean; text?: string }> {
    if (!this.settings.enabled) {
      return { handled: false };
    }
    await this.start();
    const conversation = toConversationTargetFromBeforeDispatch(event, ctx);
    if (!conversation) {
      return { handled: false };
    }

    const menuHandled = await this.tryHandleTextMenuSelection(
      conversation,
      event.content,
      ctx.senderId ?? event.senderId,
    );
    if (menuHandled) {
      return { handled: true };
    }

    if (conversation.channel === "feishu") {
      const binding = this.store.getBinding(conversation);
      const command = parseLeadingCommand(event.content);
      if (command) {
        if (command.command === "codex_stop") {
          await this.sendText(conversation, await this.detachConversation(conversation));
          return { handled: true };
        }
        if (!binding) {
          // Let Feishu's native plain-text system command dispatch own /codex_start
          // until this conversation is locally bound by the plugin.
          return { handled: false };
        }
        const reply =
          command.args === "--help" || command.args === "help"
            ? { text: formatCommandUsage("codex_start") }
            : await this.handleResumeCommand(conversation, binding, command.args, {});
        await this.dispatchReply(conversation, reply);
        return { handled: true };
      }
      if (!binding) {
        return { handled: false };
      }
      const input = await buildInboundTurnInput({
        content: event.content,
      });
      const activeKey = buildConversationKey(conversation);
      const active = this.activeRuns.get(activeKey);
      if (active) {
        const requiresStructuredInput = !isQueueCompatibleTurnInput(event.content, input);
        if (!requiresStructuredInput) {
          const queued = await active.handle.queueMessage(event.content).catch(() => false);
          if (queued) {
            return { handled: true };
          }
        }
        this.activeRuns.delete(activeKey);
        await active.handle.interrupt().catch(() => undefined);
      }
      await this.startTurn({
        conversation,
        binding,
        prompt: event.content,
        input,
      });
      return { handled: true };
    }

    const command = parseLeadingCommand(event.content);
    if (!command) {
      return { handled: false };
    }

    const binding =
      this.store.getBinding(conversation) ?? (await this.hydrateApprovedBinding(conversation));
    if (command.command === "codex_stop") {
      await this.sendText(conversation, await this.detachConversation(conversation));
      return { handled: true };
    }

    const reply =
      command.args === "--help" || command.args === "help"
        ? { text: formatCommandUsage("codex_start") }
        : await this.handleResumeCommand(conversation, binding, command.args, {});
    await this.dispatchReply(conversation, reply);
    return { handled: true };
  }

  async handleTelegramInteractive(ctx: PluginInteractiveTelegramHandlerContext): Promise<void> {
    await this.start();
    this.lastRuntimeConfig = this.lastRuntimeConfig ?? this.api.config;
    const callback = this.store.getCallback(ctx.callback.payload);
    if (!callback) {
      await ctx.respond.reply({ text: "That Codex action expired. Please run /codex_start again." });
      return;
    }
    const conversation: ConversationTarget = {
      channel: "telegram",
      accountId: callback.conversation.accountId ?? ctx.accountId,
      conversationId: callback.conversation.conversationId,
      parentConversationId: callback.conversation.parentConversationId ?? ctx.parentConversationId,
      threadId: ctx.threadId,
    };
    const bindingApi = asScopedBindingApi(ctx);

    switch (callback.kind) {
      case "resume-thread": {
        await this.store.removeCallback(callback.token);
        const result = await this.requestConversationBinding(
          conversation,
          {
            threadId: callback.threadId,
            workspaceDir: callback.workspaceDir,
            threadTitle: callback.threadTitle,
          },
          bindingApi.requestConversationBinding,
        );
        if (result.status === "pending") {
          await ctx.respond.editMessage({
            text: result.reply.text ?? "Binding approval requested.",
            buttons: extractReplyButtons(result.reply),
          });
          return;
        }
        if (result.status === "error") {
          await ctx.respond.reply({ text: result.message });
          return;
        }
        await ctx.respond.editMessage({
          text: bindingSuccessText(result.binding),
          buttons: [],
        });
        return;
      }
      case "start-new-thread": {
        await this.store.removeCallback(callback.token);
        const created = await this.client.startThread({
          sessionKey: buildPluginSessionKey(`new:${Date.now()}`),
          workspaceDir: callback.workspaceDir,
        });
        const result = await this.requestConversationBinding(
          conversation,
          {
            threadId: created.threadId,
            workspaceDir: created.cwd?.trim() || callback.workspaceDir,
            threadTitle: created.threadName,
          },
          bindingApi.requestConversationBinding,
        );
        if (result.status === "pending") {
          await ctx.respond.editMessage({
            text: result.reply.text ?? "Binding approval requested.",
            buttons: extractReplyButtons(result.reply),
          });
          return;
        }
        if (result.status === "error") {
          await ctx.respond.reply({ text: result.message });
          return;
        }
        await ctx.respond.editMessage({
          text: bindingSuccessText(result.binding),
          buttons: [],
        });
        return;
      }
      case "picker-view": {
        const picker = await this.renderPickerView(conversation, callback.view);
        await ctx.respond.editMessage({
          text: picker.text,
          buttons: picker.buttons,
        });
        return;
      }
      case "pending-input": {
        const active = this.activeRuns.get(buildConversationKey(conversation));
        if (!active) {
          await ctx.respond.reply({ text: "That pending Codex input is no longer active." });
          return;
        }
        await active.handle.submitPendingInput(callback.actionIndex);
        await this.store.removeCallback(callback.token);
        await ctx.respond.editMessage({
          text: "Sent to Codex.",
          buttons: [],
        });
        return;
      }
      case "detach-thread": {
        await this.store.removeCallback(callback.token);
        await bindingApi.detachConversationBinding?.().catch(() => ({ removed: false }));
        await this.store.removeBinding(conversation);
        await ctx.respond.editMessage({
          text: "Detached this Telegram conversation from Codex.",
          buttons: [],
        });
        return;
      }
      case "cancel-picker": {
        await this.store.removeCallback(callback.token);
        await ctx.respond.editMessage({
          text: "Cancelled.",
          buttons: [],
        });
        return;
      }
      default:
        await ctx.respond.reply({ text: "That action is unavailable in the lite plugin." });
    }
  }

  async handleInboundClaim(event: {
    content: string;
    channel: string;
    accountId?: string;
    conversationId?: string;
    parentConversationId?: string;
    senderId?: string;
    threadId?: string | number;
    media?: PluginInboundMedia[];
  }): Promise<{ handled: boolean }> {
    if (!this.settings.enabled) {
      return { handled: false };
    }
    await this.start();
    const conversation = toConversationTargetFromInbound(event);
    if (!conversation) {
      return { handled: false };
    }
    const menuHandled = await this.tryHandleTextMenuSelection(
      conversation,
      event.content,
      event.senderId,
    );
    if (menuHandled) {
      return { handled: true };
    }
    const binding =
      this.store.getBinding(conversation) ?? (await this.hydrateApprovedBinding(conversation));
    const command = parseLeadingCommand(event.content);
    if (command) {
      if (command.command === "codex_stop") {
        await this.sendText(conversation, await this.detachConversation(conversation));
        return { handled: true };
      }
      const reply =
        command.args === "--help" || command.args === "help"
          ? { text: formatCommandUsage("codex_start") }
          : await this.handleResumeCommand(conversation, binding, command.args, {});
      await this.dispatchReply(conversation, reply);
      return { handled: true };
    }
    if (!binding) {
      return { handled: false };
    }
    const input = await buildInboundTurnInput(event);
    const activeKey = buildConversationKey(conversation);
    const active = this.activeRuns.get(activeKey);
    if (active) {
      const requiresStructuredInput = !isQueueCompatibleTurnInput(event.content, input);
      if (!requiresStructuredInput) {
        const queued = await active.handle.queueMessage(event.content).catch(() => false);
        if (queued) {
          return { handled: true };
        }
      }
      this.activeRuns.delete(activeKey);
      await active.handle.interrupt().catch(() => undefined);
    }
    await this.startTurn({
      conversation,
      binding,
      prompt: event.content,
      input,
    });
    return { handled: true };
  }

  private async dispatchReply(
    conversation: ConversationTarget,
    reply: ReplyPayload,
  ): Promise<void> {
    const buttons = extractReplyButtons(reply);
    const text = reply.text?.trim();
    if (!text && !buttons) {
      return;
    }
    await this.sendReply(conversation, { text, buttons });
  }

  private async detachConversation(
    conversation: ConversationTarget,
    detachBinding?: ScopedBindingApi["detachConversationBinding"],
  ): Promise<string> {
    const hadLocalBinding = Boolean(this.store.getBinding(conversation));
    const removed = detachBinding
      ? await detachBinding().catch(() => ({ removed: false }))
      : await detachPluginConversationBinding({
          pluginRoot: PLUGIN_ROOT,
          conversation,
        }).catch(() => ({ removed: false }));
    await this.store.removeBinding(conversation);
    await this.store.removeTextMenu(conversation);
    const channelLabel = getChannelLabel(conversation.channel);
    return removed?.removed || hadLocalBinding
      ? `Detached this ${channelLabel} conversation from Codex.`
      : `This ${channelLabel} conversation is not currently bound to Codex.`;
  }

  private async tryHandleTextMenuSelection(
    conversation: ConversationTarget,
    rawText: string,
    senderId?: string,
  ): Promise<boolean> {
    const selection = parseNumericSelection(rawText);
    if (selection == null) {
      return false;
    }
    const menu = this.store.getTextMenu(conversation);
    if (!menu) {
      return false;
    }
    const option = menu.options[selection - 1];
    if (!option) {
      await this.sendText(
        conversation,
        `That option is out of range. Reply with 1-${menu.options.length}.`,
      );
      return true;
    }
    await this.store.removeTextMenu(conversation);
    await this.handleTextMenuOption(conversation, option, senderId);
    return true;
  }

  private async handleTextMenuOption(
    conversation: ConversationTarget,
    option: StoredTextMenuOption,
    senderId?: string,
  ): Promise<void> {
    if (option.kind === "binding-approval") {
      const result = await resolvePluginConversationBindingApproval({
        approvalId: option.approvalId,
        decision: option.decision,
        senderId,
      });
      if (result.status === "expired") {
        await this.sendText(conversation, "That approval request expired. Run /codex_start again.");
        return;
      }
      return;
    }

    const callback = this.store.getCallback(option.token);
    if (!callback) {
      await this.sendText(conversation, "That Codex action expired. Please run /codex_start again.");
      return;
    }
    await this.store.removeCallback(option.token);

    switch (callback.kind) {
      case "resume-thread": {
        const result = await this.requestConversationBinding(conversation, {
          threadId: callback.threadId,
          workspaceDir: callback.workspaceDir,
          threadTitle: callback.threadTitle,
        });
        if (result.status === "pending") {
          await this.dispatchReply(conversation, result.reply);
          return;
        }
        if (result.status === "error") {
          await this.sendText(conversation, result.message);
          return;
        }
        await this.sendText(conversation, bindingSuccessText(result.binding));
        return;
      }
      case "start-new-thread": {
        const created = await this.client.startThread({
          sessionKey: buildPluginSessionKey(`new:${Date.now()}`),
          workspaceDir: callback.workspaceDir,
        });
        const result = await this.requestConversationBinding(conversation, {
          threadId: created.threadId,
          workspaceDir: created.cwd?.trim() || callback.workspaceDir,
          threadTitle: created.threadName,
        });
        if (result.status === "pending") {
          await this.dispatchReply(conversation, result.reply);
          return;
        }
        if (result.status === "error") {
          await this.sendText(conversation, result.message);
          return;
        }
        await this.sendText(conversation, bindingSuccessText(result.binding));
        return;
      }
      case "picker-view": {
        const picker = await this.renderPickerView(conversation, callback.view);
        await this.sendReply(conversation, picker);
        return;
      }
      case "pending-input": {
        const active = this.activeRuns.get(buildConversationKey(conversation));
        if (!active) {
          await this.sendText(conversation, "That pending Codex input is no longer active.");
          return;
        }
        await active.handle.submitPendingInput(callback.actionIndex);
        await this.sendText(conversation, "Sent to Codex.");
        return;
      }
      case "detach-thread": {
        await this.sendText(conversation, await this.detachConversation(conversation));
        return;
      }
      case "cancel-picker": {
        await this.sendText(conversation, "Cancelled.");
        return;
      }
      default:
        await this.sendText(conversation, "That action is unavailable in the lite plugin.");
    }
  }

  private async handleResumeCommand(
    conversation: ConversationTarget,
    binding: StoredBinding | null,
    args: string,
    bindingApi: ScopedBindingApi,
  ): Promise<ReplyPayload> {
    const parsed = parseThreadSelectionArgs(args);
    if (parsed.error) {
      return { text: parsed.error };
    }

    const pendingBind = this.store.getPendingBind(conversation);
    if (pendingBind && !binding && !parsed.query && !parsed.listProjects && !parsed.startNew) {
      return {
        text: `Binding approval is still pending for thread ${pendingBind.threadTitle?.trim() || pendingBind.threadId}.`,
      };
    }

    if (parsed.startNew) {
      const directWorkspace = await this.resolveNewThreadWorkspaceDir(binding, parsed);
      if (directWorkspace) {
        const created = await this.client.startThread({
          sessionKey: buildPluginSessionKey(`new:${Date.now()}`),
          workspaceDir: directWorkspace,
        });
        const result = await this.requestConversationBinding(
          conversation,
          {
            threadId: created.threadId,
            workspaceDir: created.cwd?.trim() || directWorkspace,
            threadTitle: created.threadName,
          },
          bindingApi.requestConversationBinding,
        );
        if (result.status === "pending") {
          return result.reply;
        }
        if (result.status === "error") {
          return { text: result.message };
        }
        return { text: bindingSuccessText(result.binding) };
      }
      const picker = await this.renderProjectPicker(conversation, {
        mode: "projects",
        action: "start-new-thread",
        includeAll: parsed.includeAll || !parsed.cwd,
        page: 0,
        query: parsed.query || undefined,
        workspaceDir: parsed.cwd,
      });
      return buildPlainReply(picker.text, picker.buttons);
    }

    if (parsed.listProjects) {
      const picker = await this.renderProjectPicker(conversation, {
        mode: "projects",
        action: "resume-thread",
        includeAll: parsed.includeAll || !parsed.cwd,
        page: 0,
        query: parsed.query || undefined,
        workspaceDir: parsed.cwd,
      });
      return buildPlainReply(picker.text, picker.buttons);
    }

    if (!parsed.query) {
      const picker = await this.renderProjectPicker(conversation, {
        mode: "projects",
        action: "resume-thread",
        includeAll: parsed.includeAll || !parsed.cwd,
        page: 0,
        workspaceDir: parsed.cwd,
      });
      return buildPlainReply(picker.text, picker.buttons);
    }

    const threads = await this.listPickerThreads(binding, parsed);
    const selection = selectThreadFromMatches(threads, parsed.query);
    if (selection.kind === "unique") {
      const result = await this.requestConversationBinding(
        conversation,
        {
          threadId: selection.thread.threadId,
          workspaceDir: selection.thread.projectKey?.trim() || this.resolvePickerWorkspaceDir(parsed, binding),
          threadTitle: selection.thread.title,
        },
        bindingApi.requestConversationBinding,
      );
      if (result.status === "pending") {
        return result.reply;
      }
      if (result.status === "error") {
        return { text: result.message };
      }
      return { text: bindingSuccessText(result.binding) };
    }
    const picker = await this.renderThreadPicker(conversation, {
      mode: "threads",
      includeAll: parsed.includeAll,
      page: 0,
      query: parsed.query || undefined,
      workspaceDir: this.resolvePickerWorkspaceDir(parsed, binding),
    });
    return buildPlainReply(picker.text, picker.buttons);
  }

  private async normalizeCommandReply(
    conversation: ConversationTarget,
    reply: ReplyPayload,
  ): Promise<ReplyPayload> {
    const channel = normalizeSupportedChannel(conversation.channel);
    if (!channel) {
      return reply;
    }
    const buttons = extractReplyButtons(reply);
    if (!buttons?.length) {
      await this.store.removeTextMenu(conversation);
      return reply;
    }
    if (supportsInteractiveButtons(channel)) {
      return reply;
    }
    const options = normalizeTextMenuOptionsForChannel(channel, toTextMenuOptions(buttons));
    if (options.length === 0) {
      return {
        text: reply.text?.trim() || "Choose a Codex action:",
      };
    }
    const promptText = reply.text?.trim() || "Choose a Codex action:";
    await this.store.upsertTextMenu({
      conversation: {
        channel: conversation.channel,
        accountId: conversation.accountId,
        conversationId: conversation.conversationId,
        parentConversationId: conversation.parentConversationId,
      },
      promptText,
      options,
      expiresAt: Date.now() + CALLBACK_TTL_MS,
      updatedAt: Date.now(),
    });
    return {
      text: buildTextMenuPrompt(promptText, options),
    };
  }

  private async startTurn(params: {
    conversation: ConversationTarget;
    binding: StoredBinding;
    prompt: string;
    input?: CodexTurnInputItem[];
  }): Promise<void> {
    const key = buildConversationKey(params.conversation);
    const existing = this.activeRuns.get(key);
    if (existing) {
      await existing.handle.interrupt().catch(() => undefined);
      this.activeRuns.delete(key);
    }

    const handle = this.client.startTurn({
      sessionKey: params.binding.sessionKey,
      workspaceDir: params.binding.workspaceDir,
      existingThreadId: params.binding.threadId,
      prompt: params.prompt,
      input: params.input,
      runId: randomUUID(),
      onPendingInput: async (state) => {
        await this.handlePendingInput(params.conversation, params.binding, state);
      },
    });

    this.activeRuns.set(key, {
      conversation: params.conversation,
      handle,
      binding: params.binding,
    });

    void handle.result
      .then(async (result) => {
        if ("threadId" in result) {
          await this.handleTurnResult(params.conversation, params.binding, result);
          return;
        }
        await this.sendText(
          params.conversation,
          result.reviewText?.trim() || "Codex completed the request.",
        );
      })
      .catch(async (error) => {
        await this.sendText(params.conversation, await this.describeTurnError({
          binding: params.binding,
          error,
        }));
      })
      .finally(async () => {
        this.activeRuns.delete(key);
        const pending = this.store.getPendingRequestByConversation(params.conversation);
        if (pending) {
          await this.store.removePendingRequest(pending.requestId);
        }
      });
  }

  private async handleTurnResult(
    conversation: ConversationTarget,
    binding: StoredBinding,
    result: TurnResult,
  ): Promise<void> {
    if (result.threadId && result.threadId !== binding.threadId) {
      await this.store.upsertBinding({
        ...binding,
        threadId: result.threadId,
        sessionKey: buildPluginSessionKey(result.threadId),
        updatedAt: Date.now(),
      });
    }
    if (result.planArtifact?.markdown?.trim()) {
      await this.sendText(conversation, result.planArtifact.markdown.trim());
      return;
    }
    if (result.text?.trim()) {
      await this.sendText(conversation, result.text.trim());
      return;
    }
    if (result.terminalError?.message?.trim()) {
      await this.sendText(conversation, await this.describeTurnError({
        binding,
        error: result.terminalError.message.trim(),
        terminalError: result.terminalError,
      }));
      return;
    }
    if (result.aborted) {
      await this.sendText(conversation, "Codex run stopped.");
    }
  }

  private async describeTurnError(params: {
    binding: StoredBinding;
    error: unknown;
    terminalError?: TurnTerminalError;
  }): Promise<string> {
    const message =
      params.terminalError?.message?.trim() ||
      (params.error instanceof Error ? params.error.message : String(params.error));
    if (this.looksLikeExplicitCodexAuthFailure(params.terminalError, message)) {
      const account = await this.client
        .readAccount({
          profile: "default",
          sessionKey: params.binding.sessionKey,
          refreshToken: true,
        })
        .catch(() => undefined);
      this.api.logger.warn?.(
        `codex auth failure inferred from lite turn error session=${params.binding.sessionKey}: ${message}`,
      );
      return this.formatCodexAuthFailureMessage(account, message);
    }
    return `Codex failed:\n${message}`;
  }

  private formatCodexAuthFailureMessage(
    account: AccountSummary | undefined,
    message: string,
  ): string {
    const normalized = message.trim().toLowerCase();
    if (normalized.includes("incorrect api key provided")) {
      return "Codex authentication failed on this machine. A host `OPENAI_API_KEY` is overriding Codex login. Clear that env var or set `inheritHostAuthEnv=true` only if you intentionally want env-based auth.";
    }
    if (account?.type === "apiKey" && account.requiresOpenaiAuth !== true) {
      return "Codex authentication failed on this machine. Check the configured API key and try again.";
    }
    return "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.";
  }

  private looksLikeExplicitCodexAuthFailure(
    terminalError: TurnTerminalError | undefined,
    message: string,
  ): boolean {
    if (terminalError?.httpStatusCode === 401) {
      return true;
    }
    const codexErrorInfo = terminalError?.codexErrorInfo?.trim().toLowerCase() ?? "";
    if (codexErrorInfo.includes("unauthorized")) {
      return true;
    }
    return this.looksLikeCodexAuthFailure(message);
  }

  private looksLikeCodexAuthFailure(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return [
      "unauthorized",
      "401",
      "oauth",
      "incorrect api key provided",
      "invalid token",
      "invalid oauth",
      "invalid_grant",
      "refresh token expired",
      "requires openai auth",
      "requiresopenaiauth",
      "not signed in",
      "login required",
    ].some((pattern) => normalized.includes(pattern));
  }

  private async handlePendingInput(
    conversation: ConversationTarget,
    binding: StoredBinding,
    state: PendingInputState | null,
  ): Promise<void> {
    const existing = this.store.getPendingRequestByConversation(conversation);
    if (!state) {
      if (existing) {
        await this.store.removePendingRequest(existing.requestId);
      }
      return;
    }
    await this.store.upsertPendingRequest({
      requestId: state.requestId,
      conversation: binding.conversation,
      threadId: binding.threadId,
      workspaceDir: binding.workspaceDir,
      state,
      updatedAt: Date.now(),
    });
    const callbacks = await Promise.all(
      (state.actions ?? [])
        .filter((action) => action.kind !== "steer")
        .map(async (_action, index) =>
          await this.store.putCallback({
            kind: "pending-input",
            conversation,
            requestId: state.requestId,
            actionIndex: index,
          }),
        ),
    );
    const buttons: PluginInteractiveButtons | undefined =
      callbacks.length > 0
        ? [
            callbacks.map((callback, index) => ({
              text: state.actions?.[index]?.label ?? `Option ${index + 1}`,
              callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
            })),
          ]
        : undefined;
    await this.sendReply(conversation, {
      text: formatPendingInputText(state),
      buttons,
    });
  }

  private async bindConversation(
    conversation: ConversationTarget,
    params: {
      threadId: string;
      workspaceDir: string;
      threadTitle?: string;
    },
  ): Promise<StoredBinding> {
    const record: StoredBinding = {
      conversation: {
        channel: conversation.channel,
        accountId: conversation.accountId,
        conversationId: conversation.conversationId,
        parentConversationId: conversation.parentConversationId,
      },
      sessionKey: buildPluginSessionKey(params.threadId),
      threadId: params.threadId,
      workspaceDir: params.workspaceDir,
      threadTitle: params.threadTitle,
      updatedAt: Date.now(),
    };
    await this.store.upsertBinding(record);
    return record;
  }

  private async hydrateApprovedBinding(
    conversation: ConversationTarget,
  ): Promise<StoredBinding | null> {
    const existing = this.store.getBinding(conversation);
    if (existing) {
      return existing;
    }
    const pending = this.store.getPendingBind(conversation);
    if (!pending) {
      return null;
    }
    const binding = await this.bindConversation(conversation, pending);
    await this.store.removePendingBind(conversation);
    return binding;
  }

  private async requestConversationBinding(
    conversation: ConversationTarget,
    params: {
      threadId: string;
      workspaceDir: string;
      threadTitle?: string;
    },
    requestBinding?: ScopedBindingApi["requestConversationBinding"],
  ): Promise<
    | { status: "bound"; binding: StoredBinding }
    | { status: "pending"; reply: ReplyPayload }
    | { status: "error"; message: string }
    > {
    const summary = `Bind this conversation to Codex thread ${params.threadTitle?.trim() || params.threadId}.`;
    if (conversation.channel === "feishu") {
      try {
        const directRequest = await requestPluginConversationBinding({
          pluginId: PLUGIN_ID,
          pluginName: "OpenClaw Codex App Server Lite",
          pluginRoot: PLUGIN_ROOT,
          conversation,
          binding: { summary },
        });
        if (directRequest.status === "error") {
          return directRequest;
        }
        if (directRequest.status === "pending") {
          const resolved = await resolvePluginConversationBindingApproval({
            approvalId: directRequest.approvalId,
            decision: "allow-once",
          });
          if (resolved.status !== "approved") {
            return {
              status: "error",
              message: "Feishu binding confirmation could not be completed automatically.",
            };
          }
        }
      } catch (error) {
        if (!isSessionBindingError(error)) {
          throw error;
        }
        this.api.logger.warn?.(
          `feishu binding falling back to plugin-local state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const binding = await this.bindConversation(conversation, params);
      return { status: "bound", binding };
    }
    const approval = requestBinding
      ? await requestBinding({
          summary,
        })
      : await requestPluginConversationBinding({
          pluginId: PLUGIN_ID,
          pluginName: "OpenClaw Codex App Server Lite",
          pluginRoot: PLUGIN_ROOT,
          conversation,
          binding: { summary },
        });
    if (approval.status === "pending") {
      await this.store.upsertPendingBind({
        conversation: {
          channel: conversation.channel,
          accountId: conversation.accountId,
          conversationId: conversation.conversationId,
          parentConversationId: conversation.parentConversationId,
        },
        threadId: params.threadId,
        workspaceDir: params.workspaceDir,
        threadTitle: params.threadTitle,
        updatedAt: Date.now(),
      });
      return approval;
    }
    if (approval.status === "error") {
      return approval;
    }
    const binding = await this.bindConversation(conversation, params);
    return { status: "bound", binding };
  }

  private resolvePickerWorkspaceDir(
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    binding: StoredBinding | null,
  ): string {
    return resolveWorkspaceDir({
      requested: parsed.cwd,
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
  }

  private async listPickerThreads(
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    projectName?: string,
  ): Promise<ThreadSummary[]> {
    const workspaceDir =
      parsed.cwd
        ? parsed.cwd
        : parsed.includeAll || projectName
          ? undefined
          : this.resolvePickerWorkspaceDir(parsed, binding);
    let threads = await this.client.listThreads({
      workspaceDir,
      filter: parsed.query || undefined,
    });
    if (threads.length === 0 && workspaceDir && !projectName) {
      threads = await this.client.listThreads({
        workspaceDir: undefined,
        filter: parsed.query || undefined,
      });
    }
    return filterThreadsByProjectName(threads, projectName);
  }

  private async resolveNewThreadWorkspaceDir(
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
  ): Promise<string | null> {
    if (parsed.cwd) {
      return parsed.cwd;
    }
    const query = parsed.query.trim();
    if (!query) {
      return null;
    }
    if (looksLikePath(query)) {
      return resolveWorkspaceDir({
        requested: query,
        bindingWorkspaceDir: binding?.workspaceDir,
        configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
        serviceWorkspaceDir: this.serviceWorkspaceDir,
      });
    }
    let threads = await this.client.listThreads({
      workspaceDir: parsed.includeAll ? undefined : this.resolvePickerWorkspaceDir(parsed, binding),
    });
    if (threads.length === 0 && !parsed.includeAll) {
      threads = await this.client.listThreads({
        workspaceDir: undefined,
      });
    }
    const candidates = listProjects(threads, query);
    if (candidates.length !== 1) {
      return null;
    }
    const workspaces = listWorkspaceChoices(threads, candidates[0].name);
    return workspaces.length === 1 ? workspaces[0].workspaceDir : null;
  }

  private async renderThreadPicker(
    conversation: ConversationTarget,
    view: ThreadPickerView,
  ): Promise<PickerRender> {
    const parsed = {
      includeAll: view.includeAll,
      listProjects: false,
      startNew: false,
      cwd: view.workspaceDir,
      query: view.query ?? "",
    };
    const binding = this.store.getBinding(conversation);
    const threads = await this.listPickerThreads(binding, parsed, view.projectName);
    const page = paginateItems(threads, view.page);
    const rows: PluginInteractiveButtons = [];
    for (const thread of page.items) {
      const callback = await this.store.putCallback({
        kind: "resume-thread",
        conversation,
        threadId: thread.threadId,
        threadTitle: thread.title,
        workspaceDir: thread.projectKey?.trim() || this.resolvePickerWorkspaceDir(parsed, binding),
      });
      rows.push([
        {
          text: getThreadDisplayTitle(thread, 48),
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (page.page > 0) {
      const prev = await this.store.putCallback({
        kind: "picker-view",
        conversation,
        view: { ...view, page: page.page - 1 },
      });
      nav.push({ text: "Prev", callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}` });
    }
    if (page.page < page.totalPages - 1) {
      const next = await this.store.putCallback({
        kind: "picker-view",
        conversation,
        view: { ...view, page: page.page + 1 },
      });
      nav.push({ text: "Next", callback_data: `${INTERACTIVE_NAMESPACE}:${next.token}` });
    }
    if (nav.length > 0) {
      rows.push(nav);
    }
    const footer: Array<{ text: string; callback_data: string }> = [];
    if (view.projectName) {
      const workspaces = listWorkspaceChoices(threads, view.projectName);
      if (workspaces.length === 1) {
        const startNew = await this.store.putCallback({
          kind: "start-new-thread",
          conversation,
          workspaceDir: workspaces[0].workspaceDir,
        });
        footer.push({ text: "New", callback_data: `${INTERACTIVE_NAMESPACE}:${startNew.token}` });
      } else if (workspaces.length > 1) {
        const workspacePicker = await this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "workspaces",
            action: "start-new-thread",
            includeAll: view.includeAll,
            page: 0,
            projectName: view.projectName,
            workspaceDir: view.workspaceDir,
          },
        });
        footer.push({
          text: "New",
          callback_data: `${INTERACTIVE_NAMESPACE}:${workspacePicker.token}`,
        });
      }
    }
    const projects = await this.store.putCallback({
      kind: "picker-view",
      conversation,
      view: {
        mode: "projects",
        action: "resume-thread",
        includeAll: view.includeAll,
        page: 0,
        query: view.query,
        workspaceDir: view.workspaceDir,
      },
    });
    footer.push({ text: "Projects", callback_data: `${INTERACTIVE_NAMESPACE}:${projects.token}` });
    const cancel = await this.store.putCallback({
      kind: "cancel-picker",
      conversation,
    });
    footer.push({ text: "Cancel", callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}` });
    rows.push(footer);
    const scope = view.projectName ? `project ${view.projectName}` : view.includeAll ? "all projects" : "current workspace";
    return {
      text: `Pick a Codex thread (${scope}). Showing ${page.startIndex + 1}-${page.endIndex} of ${page.totalItems}.`,
      buttons: rows,
    };
  }

  private async renderProjectPicker(
    conversation: ConversationTarget,
    view: ProjectPickerView,
  ): Promise<PickerRender> {
    const binding = this.store.getBinding(conversation);
    const parsed = {
      includeAll: view.includeAll,
      listProjects: true,
      startNew: view.action === "start-new-thread",
      cwd: view.workspaceDir,
      query: view.query ?? "",
    };
    const requestedWorkspaceDir =
      view.includeAll ? view.workspaceDir : this.resolvePickerWorkspaceDir(parsed, binding);
    let threads = await this.client.listThreads({
      workspaceDir: requestedWorkspaceDir,
    });
    const fellBackToGlobal = threads.length === 0 && Boolean(requestedWorkspaceDir);
    if (fellBackToGlobal) {
      threads = await this.client.listThreads({
        workspaceDir: undefined,
      });
    }
    const projects = listProjects(threads, view.query ?? "");
    const page = paginateItems(projects, view.page);
    const rows: PluginInteractiveButtons = [];
    for (const project of page.items) {
      const workspaces = listWorkspaceChoices(threads, project.name);
      if (view.action === "start-new-thread" && workspaces.length === 1) {
        const callback = await this.store.putCallback({
          kind: "start-new-thread",
          conversation,
          workspaceDir: workspaces[0].workspaceDir,
        });
        rows.push([
          {
            text: `${project.name} (${project.threadCount})`,
            callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
          },
        ]);
        continue;
      }
      const callback = await this.store.putCallback({
        kind: "picker-view",
        conversation,
        view:
          view.action === "start-new-thread"
            ? {
                mode: "workspaces",
                action: "start-new-thread",
                includeAll: view.includeAll,
                page: 0,
                projectName: project.name,
                workspaceDir: view.workspaceDir,
              }
            : {
                mode: "threads",
                includeAll: view.includeAll,
                page: 0,
                projectName: project.name,
                workspaceDir: view.workspaceDir,
              },
      });
      rows.push([
        {
          text: `${project.name} (${project.threadCount})`,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (page.page > 0) {
      const prev = await this.store.putCallback({
        kind: "picker-view",
        conversation,
        view: { ...view, page: page.page - 1 },
      });
      nav.push({ text: "Prev", callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}` });
    }
    if (page.page < page.totalPages - 1) {
      const next = await this.store.putCallback({
        kind: "picker-view",
        conversation,
        view: { ...view, page: page.page + 1 },
      });
      nav.push({ text: "Next", callback_data: `${INTERACTIVE_NAMESPACE}:${next.token}` });
    }
    if (nav.length > 0) {
      rows.push(nav);
    }
    const cancel = await this.store.putCallback({
      kind: "cancel-picker",
      conversation,
    });
    rows.push([{ text: "Cancel", callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}` }]);
    return {
      text:
        view.action === "start-new-thread"
          ? `Pick a project for a new Codex thread. Showing ${page.startIndex + 1}-${page.endIndex} of ${page.totalItems}.${fellBackToGlobal ? " Searched all projects because the current workspace had no recent Codex threads." : ""}`
          : `Pick a Codex project. Showing ${page.startIndex + 1}-${page.endIndex} of ${page.totalItems}.${fellBackToGlobal ? " Searched all projects because the current workspace had no recent Codex threads." : ""}`,
      buttons: rows,
    };
  }

  private async renderWorkspacePicker(
    conversation: ConversationTarget,
    view: WorkspacePickerView,
  ): Promise<PickerRender> {
    const binding = this.store.getBinding(conversation);
    const parsed = {
      includeAll: view.includeAll,
      listProjects: true,
      startNew: true,
      cwd: view.workspaceDir,
      query: "",
    };
    const threads = await this.client.listThreads({
      workspaceDir: view.includeAll ? view.workspaceDir : this.resolvePickerWorkspaceDir(parsed, binding),
    });
    const workspaces = listWorkspaceChoices(threads, view.projectName);
    const page = paginateItems(workspaces, view.page);
    const rows: PluginInteractiveButtons = [];
    for (const workspace of page.items) {
      const callback = await this.store.putCallback({
        kind: "start-new-thread",
        conversation,
        workspaceDir: workspace.workspaceDir,
      });
      rows.push([
        {
          text: workspace.workspaceDir,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (page.page > 0) {
      const prev = await this.store.putCallback({
        kind: "picker-view",
        conversation,
        view: { ...view, page: page.page - 1 },
      });
      nav.push({ text: "Prev", callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}` });
    }
    if (page.page < page.totalPages - 1) {
      const next = await this.store.putCallback({
        kind: "picker-view",
        conversation,
        view: { ...view, page: page.page + 1 },
      });
      nav.push({ text: "Next", callback_data: `${INTERACTIVE_NAMESPACE}:${next.token}` });
    }
    if (nav.length > 0) {
      rows.push(nav);
    }
    const back = await this.store.putCallback({
      kind: "picker-view",
      conversation,
      view: {
        mode: "projects",
        action: "start-new-thread",
        includeAll: view.includeAll,
        page: 0,
        workspaceDir: view.workspaceDir,
      },
    });
    rows.push([{ text: "Back", callback_data: `${INTERACTIVE_NAMESPACE}:${back.token}` }]);
    return {
      text: `Pick a workspace for project ${view.projectName}. Showing ${page.startIndex + 1}-${page.endIndex} of ${page.totalItems}.`,
      buttons: rows,
    };
  }

  private async renderPickerView(
    conversation: ConversationTarget,
    view: Extract<CallbackAction, { kind: "picker-view" }>["view"],
  ): Promise<PickerRender> {
    if (view.mode === "threads") {
      return await this.renderThreadPicker(conversation, view as ThreadPickerView);
    }
    if (view.mode === "workspaces") {
      return await this.renderWorkspacePicker(conversation, view as WorkspacePickerView);
    }
    return await this.renderProjectPicker(conversation, view as ProjectPickerView);
  }

  private getOpenClawConfig(): unknown {
    return this.lastRuntimeConfig ?? this.api.config;
  }

  private async loadOutboundAdapter(channel: string): Promise<OutboundAdapter | undefined> {
    const loadAdapter = this.api.runtime.channel.outbound?.loadAdapter;
    if (typeof loadAdapter !== "function") {
      return undefined;
    }
    return (await loadAdapter(channel)) as OutboundAdapter | undefined;
  }

  private async sendReply(
    conversation: ConversationTarget,
    payload: { text?: string; buttons?: PluginInteractiveButtons },
    options?: { preserveTextMenu?: boolean },
  ): Promise<void> {
    const text = payload.text?.trim() ?? "";
    if (!text && !payload.buttons) {
      return;
    }
    const channel = normalizeSupportedChannel(conversation.channel);
    if (!channel) {
      throw new Error(`Unsupported channel: ${conversation.channel}`);
    }
    const { to, threadId } = resolveOutboundTarget(conversation);
    const supportsButtons = supportsInteractiveButtons(channel);
    if (!supportsButtons && payload.buttons?.length) {
      const options = normalizeTextMenuOptionsForChannel(channel, toTextMenuOptions(payload.buttons));
      if (options.length > 0) {
        const menuText = buildTextMenuPrompt(text || "Choose a Codex action:", options);
        await this.store.upsertTextMenu({
          conversation: {
            channel: conversation.channel,
            accountId: conversation.accountId,
            conversationId: conversation.conversationId,
            parentConversationId: conversation.parentConversationId,
          },
          promptText: text || "Choose a Codex action:",
          options,
          expiresAt: Date.now() + CALLBACK_TTL_MS,
          updatedAt: Date.now(),
        });
        await this.sendReply(conversation, { text: menuText }, { preserveTextMenu: true });
        return;
      }
    } else if (!payload.buttons?.length && !options?.preserveTextMenu) {
      await this.store.removeTextMenu(conversation);
    }

    const outbound = await this.loadOutboundAdapter(channel);
    const chunks = chunkText(text);
    if (chunks.length === 0 && payload.buttons && supportsButtons) {
      chunks.push("Choose a Codex action:");
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const isLast = index === chunks.length - 1;
      if (isLast && payload.buttons && outbound?.sendPayload) {
        await outbound.sendPayload({
          cfg: this.getOpenClawConfig(),
          to,
          accountId: conversation.accountId,
          threadId,
          payload: buildPlainReply(chunk, payload.buttons),
        });
        continue;
      }
      const legacySend = this.api.runtime.channel.telegram?.sendMessageTelegram;
      if (outbound?.sendText) {
        await outbound.sendText({
          cfg: this.getOpenClawConfig(),
          to,
          text: chunk,
          accountId: conversation.accountId,
          threadId,
        });
      } else if (channel === "telegram" && typeof legacySend === "function") {
        await legacySend(to, chunk, {
          accountId: conversation.accountId,
          messageThreadId: typeof threadId === "number" ? threadId : undefined,
          buttons: isLast ? payload.buttons : undefined,
        });
      } else {
        throw new Error(`${getChannelLabel(channel)} send runtime unavailable`);
      }
    }
  }

  private async sendText(conversation: ConversationTarget, text: string): Promise<void> {
    await this.sendReply(conversation, { text });
  }
}
