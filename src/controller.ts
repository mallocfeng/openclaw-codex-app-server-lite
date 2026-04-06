import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
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
  type CodexTurnInputItem,
  type ConversationTarget,
  type PendingInputState,
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

function normalizeTelegramChatId(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("telegram:") ? trimmed.slice("telegram:".length) : trimmed;
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

function toConversationTargetFromCommand(ctx: PluginCommandContext): ConversationTarget | null {
  if (!isTelegramChannel(ctx.channel)) {
    return null;
  }
  const chatId = normalizeTelegramChatId(ctx.to ?? ctx.from ?? ctx.senderId);
  if (!chatId) {
    return null;
  }
  return {
    channel: "telegram",
    accountId: ctx.accountId ?? "default",
    conversationId:
      typeof ctx.messageThreadId === "number" ? `${chatId}:topic:${ctx.messageThreadId}` : chatId,
    parentConversationId: typeof ctx.messageThreadId === "number" ? chatId : undefined,
    threadId: ctx.messageThreadId,
  };
}

function toConversationTargetFromInbound(event: {
  channel: string;
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  threadId?: string | number;
}): ConversationTarget | null {
  if (!isTelegramChannel(event.channel) || !event.accountId || !event.conversationId) {
    return null;
  }
  return {
    channel: "telegram",
    accountId: event.accountId,
    conversationId: event.conversationId,
    parentConversationId: event.parentConversationId,
    threadId:
      typeof event.threadId === "number"
        ? event.threadId
        : typeof event.threadId === "string" && Number.isFinite(Number(event.threadId))
          ? Number(event.threadId)
          : undefined,
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
  return `Bound this Telegram conversation to Codex thread:\n- ${title}\n- workspace: ${binding.workspaceDir}`;
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
    if (event.request.conversation.channel !== "telegram") {
      return;
    }
    const conversation: ConversationTarget = {
      channel: "telegram",
      accountId: event.request.conversation.accountId,
      conversationId: event.request.conversation.conversationId,
      parentConversationId: event.request.conversation.parentConversationId,
      threadId:
        typeof event.request.conversation.threadId === "number"
          ? event.request.conversation.threadId
          : typeof event.request.conversation.threadId === "string" &&
              Number.isFinite(Number(event.request.conversation.threadId))
            ? Number(event.request.conversation.threadId)
            : undefined,
    };
    const pending = this.store.getPendingBind(conversation);
    if (!pending) {
      return;
    }
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
      return { text: "This plugin currently supports Telegram conversations only." };
    }
    const bindingApi = asScopedBindingApi(ctx);
    const binding =
      this.store.getBinding(conversation) ?? (await this.hydrateApprovedBinding(conversation));
    const args = ctx.args?.trim() ?? "";

    if (commandName === "codex_stop") {
      const removed = await bindingApi.detachConversationBinding?.().catch(() => ({ removed: false }));
      await this.store.removeBinding(conversation);
      return {
        text: removed?.removed
          ? "Detached this Telegram conversation from Codex."
          : "This Telegram conversation is not currently bound to Codex.",
      };
    }

    if (args === "--help" || args === "help") {
      return { text: formatCommandUsage("codex_start") };
    }

    return await this.handleResumeCommand(conversation, binding, args, bindingApi);
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
    const binding =
      this.store.getBinding(conversation) ?? (await this.hydrateApprovedBinding(conversation));
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
    if (!requestBinding) {
      return {
        status: "error",
        message: "This action can only bind from a live command or interactive context.",
      };
    }
    const approval = await requestBinding({
      summary: `Bind this conversation to Codex thread ${params.threadTitle?.trim() || params.threadId}.`,
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

  private async loadTelegramOutboundAdapter(): Promise<TelegramOutboundAdapter | undefined> {
    const loadAdapter = this.api.runtime.channel.outbound?.loadAdapter;
    if (typeof loadAdapter !== "function") {
      return undefined;
    }
    return (await loadAdapter("telegram")) as TelegramOutboundAdapter | undefined;
  }

  private async sendReply(
    conversation: ConversationTarget,
    payload: { text?: string; buttons?: PluginInteractiveButtons },
  ): Promise<void> {
    const text = payload.text?.trim() ?? "";
    if (!text) {
      return;
    }
    const outbound = await this.loadTelegramOutboundAdapter();
    const target = conversation.parentConversationId ?? conversation.conversationId;
    const chunks = chunkText(text);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const isLast = index === chunks.length - 1;
      if (isLast && payload.buttons && outbound?.sendPayload) {
        await outbound.sendPayload({
          cfg: this.getOpenClawConfig(),
          to: target,
          accountId: conversation.accountId,
          threadId: conversation.threadId,
          payload: buildPlainReply(chunk, payload.buttons),
        });
        continue;
      }
      const legacySend = this.api.runtime.channel.telegram?.sendMessageTelegram;
      if (outbound?.sendText) {
        await outbound.sendText({
          cfg: this.getOpenClawConfig(),
          to: target,
          text: chunk,
          accountId: conversation.accountId,
          threadId: conversation.threadId,
        });
      } else if (typeof legacySend === "function") {
        await legacySend(target, chunk, {
          accountId: conversation.accountId,
          messageThreadId: conversation.threadId,
          buttons: isLast ? payload.buttons : undefined,
        });
      } else {
        throw new Error("Telegram send runtime unavailable");
      }
    }
  }

  private async sendText(conversation: ConversationTarget, text: string): Promise<void> {
    await this.sendReply(conversation, { text });
  }
}
