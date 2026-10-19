/**
 * Shared conversation message schema — strict TypeScript interfaces.
 *
 * Derived from the three importer normalizers (chatgpt, claude, deepseek).
 * Every platform produces a Conversation shape conforming to this schema,
 */

// ── Enums ────────────────────────────────────────────────────────────────────

/** Supported source platforms for exported conversations. */
export enum Platform {
  ChatGPT  = "chatgpt",
  Claude   = "claude",
  DeepSeek = "deepseek",
  Grok     = "grok"
}

/** Discriminant used by every ContentBlock variant. */
export enum ContentBlockType {
  Text = "text"
}

// ── Conversation ─────────────────────────────────────────────────────────────

export interface Conversation {
  /** Platform discriminator identifying the source exporter. */
  platform: Platform;

  /** Normalised conversation identifier (opaque string from each platform). */
  conversationId: string | null;

  /** Deep-link back to the original conversation on the provider site. */
  conversationUrl: string | null;

  /** Human-readable title, normalised to "" when missing. */
  title: string;

  /** Model identifier associated with the assistant platform-level (nullable). */
  model: string | null;

  /** Ordered list of messages in chronological order. */
  messages: Message[];
}

// ── Message ──────────────────────────────────────────────────────────────────

export interface Message {
  /** Stable, opaque message identifier from the source platform. */
  id: string;

  /** Parent message ID — null when the message has no predecessor. */
  parentId: string | null;

  /** Canonical role (user or assistant). */
  role: "user" | "assistant";

  /** Raw provider-side role before normalisation (may be richer, e.g. "tool"). */
  sourceRole: string;

  /** ISO-8601 UTC timestamp of creation; null when unavailable. */
  createdAt: string | null;

  /** Model the assistant used for this specific message (null for user messages). */
  model: string | null;

  /** Normalised content blocks. */
  content: ContentBlock[];

  /** Attachments referenced by or accompanying this message. */
  attachments: (ChatGPTAttachment | ClaudeRemoteImageAttachment | ClaudeLocalResourceAttachment |
                  CloudflareClaudeAttachment | DeepSeekUserFileAttachment | DeepSeekExternalImageAttachment |
                  GrokUserAssetAttachment)[];

  /** true when every message preceding this one was ommitted in the source data. */
  omittedBefore?: boolean;

  /** true when every message following this one was ommitted in the source data. */
  omittedAfter?: boolean;
}

// ── Content Blocks ───────────────────────────────────────────────────────────

export interface TextContentBlock {
  type: ContentBlockType.Text;
  text: string;
  format: "markdown";
}

export type ContentBlock = TextContentBlock;

// ── Attachments — discriminative union by .source ────────────────────────────

/** ChatGPT sandbox attachment. */
export interface ChatGPTAttachment {
  source: "sandbox";
  id?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  size?: number | null;
  conversationId: string | null;
  messageId: string | null;
}

/** External (remote-hosted) image attachment from Claude. */
export interface ClaudeRemoteImageAttachment {
  source: "claude-remote-image";
  id: string;
  remoteUrl: string;
  sourceUrl: string | null;
  originalName: string;
  title: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/octet-stream";
  isImage: true;
}

/** Locally-saved Claude file attachment (local_resource). */
export interface ClaudeLocalResourceAttachment {
  source: "claude-local-resource";
  id: string;
  filePath: string;
  originalName: string | null;
  mimeType: string;
  conversationId: string | null;
}

/** Custom visual attachment from the Claude __customVisuals array (SVG inline). */
export interface CloudflareClaudeAttachment {
  source: "claude-custom-visual";
  id: string;
  originalName: string;
  mimeType: "image/svg+xml";
  width: number | null;
  height: number | null;
  isImage: true;
}

/** DeepSeek file uploaded by the user (signed_path). */
export interface DeepSeekUserFileAttachment {
  source: "deepseek-user-file";
  id: string;
  signedPath: string;
  providerOriginalName: string | null;
  originalName: string | null;
  title: string | null;
  mimeType: string;
  size: number | null;
  width: number | null;
  height: number | null;
  isImage: boolean;
}

/** DeepSeek external image extracted from Markdown (replaced via attachment:// URL). */
export interface DeepSeekExternalImageAttachment {
  source: "deepseek-remote-image";
  id: string;
  remoteUrl: string;
  sourceUrl: string | null;
  originalName: string | null;
  title: string;
  mimeType: "application/octet-stream";
  isImage: true;
}

/** Grok user-uploaded asset attachment (user-assets). */
export interface GrokUserAssetAttachment {
  source: "grok-user-asset";
  id: string;
  assetId: string;
  originalName: string | null;
  title: string | null;
  mimeType: string;
  isImage: boolean;
}

// ── Extracted attachments (content script → popup → background) ─────────────

/**
 * One downloaded chat attachment travelling from the content script to the
 * service worker. The bytes are carried as base64 because
 * chrome.runtime messaging JSON-serialises its payload — typed arrays would
 * not survive the trip.
 */
export interface ExtractedAttachment {
  /** Filename to use inside the ZIP (sanitised; the background still dedupes). */
  filename: string;

  /** MIME type when known (used to fill in a missing file extension). */
  mimeType?: string | null;

  /** Base64-encoded file bytes (no `data:` prefix). */
  dataBase64: string;
}

// ── Export options (popup → background) ──────────────────────────────────────

/**
 * User-chosen export settings sent by the popup alongside the extracted
 * conversation data. Every field is optional — the background applies the
 * same defaults as the popup when a field is missing.
 */
export interface ExportOptions {
  /** Base name for the downloaded ZIP (sanitised); empty → conversation title → timestamp. */
  exportName?: string;

  /** Display label printed for user messages (default "User"). */
  userLabel?: string;

  /** Display label printed for assistant messages (default "Assistant"). */
  assistantLabel?: string;

  /** Which files to include in the ZIP. Both default to true when omitted. */
  formats?: {
    markdown?: boolean;
    html?: boolean;
  };

  /** When true, prepend the original conversation link to the rendered files. */
  includeChatLink?: boolean;

  /** When true, include the downloaded chat attachments as files in the ZIP. */
  saveAttachments?: boolean;

  /**
   * When true (and saveAttachments), place attachments under an
   * "attachments/" folder instead of the ZIP root. Ignored when
   * saveAttachments is false.
   */
  attachmentsInFolder?: boolean;

  /** URL of the conversation being exported (source for the chat link). */
  sourceUrl?: string | null;
}
