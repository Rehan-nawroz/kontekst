/**
 * ChatGPTExtractor — fetches a ChatGPT conversation via REST API and walks the
 * node tree (mapping) to build an ordered chat history.
 *
 * Implementation pattern sourced from the reference normalisers:
 *  - getConversationInPage + rawBranchFromCurrent   → api.js / conversation.js
 *  - normalizeChatGPTConversation + textParts        → chatgpt-normalize.js   / conversation.js
 */

import { BaseExtractor } from "./BaseExtractor";
import { Platform, ContentBlockType } from "../core/types";
import type { Conversation, Message, TextContentBlock } from "../core/types";
import { HttpClient } from "../core/HttpClient";

// ────────────────────── Internal node type ──────────────────────────────────

/** Shape extracted from the ChatGPT `mapping` dictionary of an active session. */
interface MappingNode {
  id: string;
  children?: string[];
  parent?: string | null;
  message: MappingMessage;
}

interface MappingMessage {
  author: { role: string };
  content: MessagingContent;
  create_time?: number | string;
  metadata: Record<string, unknown>;
  recipient?: string;
  id: string;
}

interface MessagingContent {
  content_type?: string;
  text?: string;
  parts?: (string | { partType?: string })[];
}

/** Shape of the full response returned by `/backend-api/conversation/<id>`. */
interface ConversationResponse {
  current_node: string;
  mapping: Record<string, MappingNode>;
  conversation_id?: string | null;
  title?: string;
}

// ──────────────── visibility filters (from reference) ───────────────────────

/**
 * Determine whether a message node should appear in the exported history.
 * Mirror of isVisibleMessage from the source normaliser conversation.js.
 */
function isVisibleMessage(msg: MappingMessage): boolean {
  if (!msg) return false;

  const authorRole = msg.author?.role || "unknown";

  // Hide internal captions and tool summaries.
  if (authorRole === "tool") {
    const ct = msg.content?.content_type || "";
    if (["reasoning_recap", "thoughts", "system_error", "model_editable_context", "computer_initialize_state"].includes(ct)) {
      return false;
    }
  }

  // Assistant messages addressed to a specific tool are internal infra — skip.
  if (authorRole === "assistant") {
    const recipient = typeof msg.recipient === "string" ? msg.recipient.trim() : "";
    if (recipient && recipient !== "all") return false;
  }

  // Model caption nodes — skip.
  if (msg.content?.text && /^[Mm]odel\s+caption:/i.test(msg.content.text)) return false;

  const type = msg.content?.content_type;
  if ([
    "reasoning_recap",
    "thoughts",
    "system_error",
    "model_editable_context",
    "computer_initialize_state"
  ].includes(type || "")) {
    return false;
  }

  // Tool messages that carry no image reference are also internal.
  if (authorRole === "tool") return false;

  // Visible roles: user and assistant (unaddressed).
  return authorRole === "user" || (authorRole === "assistant" && !msg.recipient);
}

// ─────────── textParts / cleanExportText helpers ────────────────────────────

/** Strip Markdown-link citations ChatGPT uses internally (\uE200… markers). */
function cleanExportText(text: string, msg?: MappingMessage): string | null {
  if (typeof text !== "string") return null;

  const isUser = msg?.author?.role === "user";
  let result = text;
  if (!isUser) {
    // Remove memo-cite markers regardless of role for cleanliness.
    result = result.replaceAll("\uE200memcite\uE201", "");
    result = result.replace(/\uE200cite(?:\uE202[^\uE201]*)*\uE201/g, "");
  }
  return result;
}

/** Extract text paragraphs from a message's content blob. Mirror of the source `textParts`. */
function extractTextParts(msg: MappingMessage): string[] {
  const content = msg.content || {};
  const parts: (string | object)[] | undefined = Array.isArray(content.parts) ? content.parts : undefined;

  if (parts) {
    return parts
      .filter(p => typeof p === "string")
      .map(t => cleanExportText(t, msg))
      .filter((t): t is string => t != null && t.trim() !== "");
  }

  const text = typeof content.text === "string" ? content.text : "";
  if (text) {
    const cleaned = cleanExportText(text, msg);
    if (cleaned && cleaned.trim()) return [cleaned];
  }

  return [];
}

// ───────────── rawBranchFromCurrent — tree walk ──────────────────────────

/**
 * Walk the message graph backwards from current_node to the root.
 * Pattern sourced from the reference normaliser conversation.js `rawBranchFromCurrent`.
 */
function buildBranch(data: ConversationResponse): MappingNode[] {
  const out: MappingNode[] = [];
  let id: string | undefined = data.current_node;
  const seen = new Set<string>();

  while (id && id !== "client-created-root" && !seen.has(id)) {
    seen.add(id);
    const node: MappingNode | undefined = data.mapping[id];
    if (!node) break;
    out.push({ ...node }); // shallow clone for type safety
    id = node.parent ?? undefined;
  }

  return out.reverse(); // chronological order
}

// ──────────────── markdown-normalization helpers ────────────────────────────

/** Normalise ChatGPT LaTeX delimiters (\[ … \] / \( … \)) → $…$ / $$…$$. */
function normaliseMathDelimiters(text: string): string {
  let source = text;
  // Replace double-backslash bracket pairs with $$ delimiters.
  source = source.replace(/(?<!\\)\\\[((?:.|\n)*?)(?<!\\)\\\]/g, "$$$$1$$$$");
  // Replace double-backslash paren pairs with $ delimiters.
  source = source.replace(/(?<!\\)\\\(([^\n]*?)(?<!\\)\\\)/g, "$$$1$");
  return source;
}

// ──────────────── node-to-message normalisation ────────────────────────────

/**
 * Walk a branch array, filter visible messages and build ContentBlock[] arrays.
 * Pattern sourced from the reference normaliser chatgpt-normalize.js `normalizeChatGPTConversation`.
 */
function walkBranch(
  nodes: MappingNode[],
  conversationId: string | null,
): Message[] {
  const messages: Message[] = [];
  let omissionPending = false;

  for (const node of nodes) {
    const msg = node.message;
    if (!msg || !isVisibleMessage(msg)) continue;

    const sourceRole = msg.author?.role || "unknown";
    // Map ChatGPT's internal "tool" role to "assistant" but preserve the original.
    const role: "user" | "assistant" =
      sourceRole === "tool" ? "assistant" : (sourceRole as "user" | "assistant");

    if (role !== "user" && role !== "assistant") continue;

    // Determine model from metadata, falling back to null.
    const model: string | null =
      typeof msg.metadata?.model_slug === "string"
        ? msg.metadata.model_slug
        : typeof msg.metadata?.resolved_model_slug === "string"
          ? msg.metadata.resolved_model_slug
          : null;

    // Convert create_time (seconds-since-epoch) to ISO.
    let createdAt: string | null = null;
    if (typeof msg.create_time === "number" || typeof msg.create_time === "string") {
      const ts = Number(msg.create_time);
      if (Number.isFinite(ts)) createdAt = new Date(ts * 1000).toISOString();
    }

    // Build content blocks.
    const textParts = extractTextParts(msg);
    const contentBlocks: TextContentBlock[] = textParts.map(text => ({
      type: ContentBlockType.Text,
      text: normaliseMathDelimiters(text),
      format: "markdown" as const,
    }));

    if (!contentBlocks.length) continue; // skip blank messages

    if (omissionPending && !messages.length) {
      omissionPending = false; // first visible message gets the flag on next
    }

    const message: Message = {
      id: msg.id,
      parentId: node.parent || null,
      role,
      sourceRole,
      createdAt,
      model,
      content: contentBlocks,
      attachments: [], // placeholder — full attachment extraction in a later step
    };

    messages.push(message);
  }

  return messages;
}

// ──────────────── ChatGPTExtractor class ───────────────────────────────────

export class ChatGPTExtractor extends BaseExtractor {
  private httpClient = new HttpClient();

  constructor() {
    super(Platform.ChatGPT);
  }

  // ── isValidPage ────────────────────────────────────────────────────────

  async isValidPage(tabId: number): Promise<boolean> {
    try {
      const tabUrl = (await chrome.tabs.get(tabId))?.url;
      if (!tabUrl) return false;
      // ChatGPT conversations live under /c/<uuid> paths.
      return (/^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(tabUrl));
    } catch {
      return false;
    }
  }

  // ── extractConversation ────────────────────────────────────────────────

  /**
   * Fetch the full active conversation via REST API and walk the node tree.
   * Pattern sourced from chatgpt-api.js `getConversationInPage` +
   * chatgpt-normalize.js `normalizeChatGPTConversation`.
   */
  async extractConversation(tabId: number): Promise<Record<string, unknown>> {
    if (!await this.isValidPage(tabId)) {
      throw new Error("Not a valid ChatGPT conversation page");
    }

    // Extract the conversation ID from the URL path.
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) throw new Error("Cannot read tab URL");
    const match = tab.url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!match) throw new Error("No active conversation");
    const conversationId = match[0];

    // Fetch auth session token.
    const accessToken = await this.fetchAccessToken();
    this.httpClient["_cachedToken"] = {
      accessToken,
      updatedAt: Date.now()
    } as any;

    // Fetch the conversation graph (current_node + mapping).
    const url = `/backend-api/conversation/${conversationId}`;
    const data: ConversationResponse = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    }).then(r => r.json());

    if (!this.isActiveConversationData(data)) throw new Error("Not a valid ChatGPT conversation response");

    // Walk the tree.
    const branch = buildBranch(data);
    const messages = walkBranch(branch, data.conversation_id || null);

    return {
      platform: Platform.ChatGPT,
      conversationId: data.conversation_id || null,
      conversationUrl: data.conversation_id ? `https://chatgpt.com/c/${data.conversation_id}` : null,
      title: typeof data.title === "string" ? data.title : "",
      messages,
    };
  }

  // ── listConversations ──────────────────────────────────────────────────

  async listConversations(page = 0, pageSize = 20): Promise<Record<string, unknown>[]> {
    const accessToken = await this.fetchAccessToken();
    const url = `/backend-api/conversations?page=${page}&limit=${pageSize}&order=created_at`;

    return fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    }).then(r => r.json());
  }

  // ── getConversation (by ID) ────────────────────────────────────────────

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    const accessToken = await this.fetchAccessToken();
    const url = `/backend-api/conversation/${conversationId}`;
    const data = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    }).then(r => r.json()) as ConversationResponse;

    if (!this.isActiveConversationData(data)) throw new Error("Not a valid conversation response");

    const branch = buildBranch(data);
    const messages = walkBranch(branch, data.conversation_id || null);

    return {
      platform: Platform.ChatGPT,
      conversationId: data.conversation_id || null,
      conversationUrl: data.conversation_id ? `https://chatgpt.com/c/${data.conversation_id}` : null,
      title: typeof data.title === "string" ? data.title : "",
      messages,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** Check that the fetched payload matches a live-chatgpt session. */
  private isActiveConversationData(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const d = data as Record<string, unknown>;
    if (typeof d.current_node !== "string" || !d.current_node) return false;
    if (d.mapping == null || typeof d.mapping !== "object") return false;
    return true;
  }

  /** Fetch or refresh the user's ChatGPT auth session token. */
  private async fetchAccessToken(): Promise<string> {
    const cached: { accessToken: string; updatedAt: number } | null =
      (this.httpClient as any)._cachedToken || null;

    if (cached && Date.now() - cached.updatedAt < 5 * 60 * 1000) {
      return cached.accessToken;
    }

    const res = await fetch("/api/auth/session", {
      credentials: "include",
    }).then(r => r.json());

    if (!res?.accessToken) throw new Error("Cannot get ChatGPT auth token");

    this.httpClient["_cachedToken"] = { accessToken: res.accessToken, updatedAt: Date.now() } as any;
    return res.accessToken;
  }
}
