/**
 * Pure, chrome-free attachment descriptor builders for the three non-DeepSeek
 * platforms. Ported 1:1 from the reference exporter (ai-chat-export-main):
 *
 *  - ChatGPT: attachments.js  (extractFileId / attachmentRecords / sandbox)
 *  - Claude:  claude-normalize.js (extractClaudeContent)
 *  - Grok:    grok-normalize.js (parseGrokCards / attachmentFromCard /
 *             userAssetAttachments)
 *
 * These functions only decide WHAT to download. The content scripts decide HOW
 * to fetch each platform's URLs — credentials, referrers and auth headers
 * differ per provider (see provider-internals.md in the reference repo).
 */

/* ═══════════════════════════ ChatGPT ═══════════════════════════════════════ */

/**
 * One ChatGPT file attachment reference. `fileId` is the normalised Estuary id
 * (`file_…`); `signedUrl` is set only when a conversation-level safe URL
 * explicitly names this file.
 */
export interface ChatGptFileDescriptor {
  fileId: string;
  originalName: string | null;
  mimeType: string | null;
  isImage: boolean;
  signedUrl: string | null;
}

/** A sandbox artifact referenced only through a Markdown link. */
export interface ChatGptSandboxDescriptor {
  /** e.g. /mnt/data/example.zip */
  sandboxPath: string;
  /** e.g. sandbox:/mnt/data/example.zip (the raw link target) */
  sandboxUrl: string;
  originalName: string | null;
}

/**
 * Normalise any observed ChatGPT file-reference form to its Estuary id.
 * Observed forms: `file_…`, `sediment://file_…`, `file-service://file-…`,
 * and backend URLs carrying `?id=file_…` (older project chats append a gizmo
 * query to an otherwise plain id).
 */
export function extractChatGptFileId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const sediment = trimmed.match(/^sediment:\/\/(file_[A-Za-z0-9_-]+)/);
  if (sediment) return sediment[1];

  const plain = trimmed.match(/^(file_[A-Za-z0-9_-]+)(?:[?#].*)?$/);
  if (plain) return plain[1];

  const service = trimmed.match(/^file-service:\/\/(file[_-][A-Za-z0-9_-]+)/);
  if (service) return service[1];

  try {
    const url = new URL(trimmed.replaceAll('&amp;', '&'));
    const id = url.searchParams.get('id');
    if (id?.startsWith('file_')) return id.replace(/[?#].*$/, '');
  } catch {
    // not a URL — fall through
  }
  return null;
}

/** Heuristic ported from attachments.js — does a record describe an image? */
function recordLooksLikeImage(value: Record<string, unknown>): boolean {
  const mimeType = String(value.mime_type || value.mimeType || '').toLowerCase();
  if (mimeType.startsWith('image/')) return true;

  const structural = String(
    value.content_type || value.contentType || value.type || '',
  ).toLowerCase();
  if (structural === 'image_asset_pointer' || structural.startsWith('image/')) return true;

  const source = String(value.source || '').toLowerCase();
  if (source.includes('image')) return true;

  for (const key of Object.keys(value)) {
    if (/image_(?:asset_)?pointer|image_url|image_src/i.test(key)) return true;
  }

  const name =
    value.name || value.filename || value.file_name ||
    value.original_name || value.originalName || value.title || '';
  if (/\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i.test(String(name))) {
    return true;
  }

  return Number.isFinite(Number(value.width)) && Number.isFinite(Number(value.height));
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function walkObjects(value: unknown, visit: (obj: Record<string, unknown>) => void, seen = new WeakSet<object>()): void {
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  visit(value as Record<string, unknown>);
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit, seen);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) walkObjects(item, visit, seen);
  }
}

/**
 * Collect every attachment descriptor referenced by one ChatGPT API message.
 *
 * Sources (in reference order):
 *  1. `message.metadata.attachments` — uploaded documents.
 *  2. Structural file records nested in `message.content` (pasted images live
 *     in `multimodal_text` parts as `image_asset_pointer` objects whose
 *     `asset_pointer` is `sediment://file_…`).
 *  3. `image_gen_title` at message level — fallback name for generated images.
 *  4. Conversation-level `safe_urls` — signed Estuary URLs, authoritative for
 *     their file id, but only kept when the id already belongs to this message.
 *
 * The walk is restricted to `msg.content` (like the reference): file ids in
 * unrelated citation/tool metadata would create false attachments.
 */
export function chatGptAttachmentDescriptors(
  msg: { id?: string; metadata?: Record<string, unknown> | null; content?: unknown } | null | undefined,
  conversationSafeUrls: string[] = [],
): ChatGptFileDescriptor[] {
  const byId = new Map<string, ChatGptFileDescriptor>();

  const merge = (rec: Partial<ChatGptFileDescriptor> & { fileId: string }): void => {
    const old = byId.get(rec.fileId);
    byId.set(rec.fileId, {
      fileId: rec.fileId,
      originalName: rec.originalName ?? old?.originalName ?? null,
      mimeType: rec.mimeType ?? old?.mimeType ?? null,
      isImage: rec.isImage ?? old?.isImage ?? false,
      signedUrl: rec.signedUrl ?? old?.signedUrl ?? null,
    });
  };

  // 1. Explicit attachment metadata.
  const meta = msg?.metadata?.attachments;
  if (Array.isArray(meta)) {
    for (const raw of meta as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object') continue;
      const id =
        extractChatGptFileId(raw.id) ||
        extractChatGptFileId(raw.asset_pointer) ||
        extractChatGptFileId(raw.url) ||
        extractChatGptFileId(raw.download_url);
      if (!id) continue;
      merge({
        fileId: id,
        originalName: firstString(raw.name, raw.filename, raw.original_name, raw.originalName, raw.title),
        mimeType: firstString(raw.mime_type, raw.mimeType),
        isImage: recordLooksLikeImage(raw),
      });
    }
  }

  // 2. Structural file records inside message content.
  walkObjects(msg?.content, obj => {
    let fileId: string | null = null;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'string') continue;
      if (/^(?:asset_pointer|file_id|fileId|download_url|content_url|image_url|url|src)$/i.test(key)) {
        fileId = extractChatGptFileId(value) || fileId;
      }
    }
    if (!fileId) return;
    const nestedMeta = obj.metadata as Record<string, unknown> | undefined;
    merge({
      fileId,
      originalName: firstString(
        obj.name, obj.filename, obj.file_name, obj.original_name, obj.originalName, obj.title,
        nestedMeta?.name, nestedMeta?.filename, nestedMeta?.file_name, nestedMeta?.original_name,
      ),
      mimeType: firstString(
        obj.mime_type, obj.mimeType,
        typeof obj.content_type === 'string' && obj.content_type.includes('/') ? obj.content_type : null,
      ),
      isImage: recordLooksLikeImage(obj),
    });
  });

  // 3. Message-level generated-image title as a fallback name.
  const imageGenTitle = typeof msg?.metadata?.image_gen_title === 'string'
    ? (msg.metadata.image_gen_title as string).trim()
    : '';
  if (imageGenTitle) {
    for (const [id, rec] of byId) {
      if (rec.isImage && !rec.originalName) byId.set(id, { ...rec, originalName: imageGenTitle });
    }
  }

  // 4. Signed Estuary URLs (conversation-level) — only for known file ids.
  for (const raw of conversationSafeUrls || []) {
    try {
      const url = new URL(String(raw).replaceAll('&amp;', '&'));
      if (!url.pathname.includes('/backend-api/estuary/content')) continue;
      const id = url.searchParams.get('id');
      if (!id?.startsWith('file_')) continue;
      if (byId.has(id)) merge({ fileId: id, signedUrl: url.href });
    } catch {
      // not a URL — ignore
    }
  }

  return [...byId.values()];
}

const SANDBOX_LINK_RE = /\[([^\]\r\n]+)\]\((sandbox:\/mnt\/data\/[^)\r\n]+)\)/g;

/**
 * Parse `[Download file](sandbox:/mnt/data/example.zip)` links out of a
 * message's text parts. Sandbox artifacts are not exposed as ordinary
 * attachments — the conversation/message context is required to resolve them.
 */
export function chatGptSandboxDescriptors(texts: string[]): ChatGptSandboxDescriptor[] {
  const out: ChatGptSandboxDescriptor[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (typeof text !== 'string' || !text.includes('sandbox:/mnt/data/')) continue;
    SANDBOX_LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SANDBOX_LINK_RE.exec(text)) !== null) {
      const sandboxUrl = match[2].trim();
      if (seen.has(sandboxUrl)) continue;
      seen.add(sandboxUrl);
      let sandboxPath = sandboxUrl.slice('sandbox:'.length);
      try {
        sandboxPath = decodeURI(sandboxPath);
      } catch {
        // keep the raw path when decoding fails
      }
      const base = sandboxPath.split('/').filter(Boolean).at(-1) || null;
      let originalName: string | null = null;
      if (base) {
        try {
          originalName = decodeURIComponent(base);
        } catch {
          originalName = base;
        }
      }
      out.push({ sandboxUrl, sandboxPath, originalName });
    }
  }
  return out;
}

/* ═════════════════════════════ Claude ══════════════════════════════════════ */

export type ClaudeAttachmentDescriptor =
  /** Claude-hosted file (generated tool output or upload) — wiggle/download-file. */
  | {
      kind: 'local-resource';
      /** Stable dedup key (per file path). */
      key: string;
      filePath: string;
      originalName: string | null;
      mimeType: string;
    }
  /** Directly referenced remote image — fetched best-effort with CORS. */
  | {
      kind: 'remote-image';
      key: string;
      url: string;
      originalName: string | null;
      title: string;
      mimeType: string;
    }
  /** Inline base64 image block — no download required. */
  | {
      kind: 'inline-image';
      key: string;
      dataBase64: string;
      originalName: string | null;
      mimeType: string;
    };

function remoteImageMimeFromUrl(url: string): string {
  let pathName = '';
  try {
    pathName = new URL(url).pathname.split('/').filter(Boolean).at(-1) || '';
  } catch {
    pathName = '';
  }
  const ext = (pathName.match(/\.([A-Za-z0-9]{2,5})(?:$|[?#])/i)?.[1] || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

function claudeRemoteImage(image: {
  id?: unknown; url?: unknown; title?: unknown; source?: unknown; page_url?: unknown;
} | null | undefined): ClaudeAttachmentDescriptor | null {
  const remoteUrl = typeof image?.url === 'string' ? image.url.trim() : '';
  if (!remoteUrl) return null;

  const title = String(image?.title || image?.source || 'Image')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Image';

  let pathName = '';
  try {
    pathName = new URL(remoteUrl).pathname.split('/').filter(Boolean).at(-1) || '';
  } catch {
    pathName = '';
  }
  let decoded = pathName;
  try {
    decoded = decodeURIComponent(pathName);
  } catch {
    decoded = pathName;
  }
  const originalName = decoded && /\.[A-Za-z0-9]{1,10}$/.test(decoded) ? decoded : title;

  return {
    kind: 'remote-image',
    key: `remote:${remoteUrl}`,
    url: remoteUrl,
    originalName,
    title,
    mimeType: remoteImageMimeFromUrl(remoteUrl),
  };
}

interface ClaudeContentItem {
  type?: unknown;
  file_path?: unknown;
  name?: unknown;
  mime_type?: unknown;
  uuid?: unknown;
  images?: unknown;
  source?: unknown;
  url?: unknown;
  data?: unknown;
  media_type?: unknown;
  content?: unknown;
}

/**
 * Collect every attachment descriptor from one Claude chat_messages entry.
 * Ported from extractClaudeContent:
 *  - `tool_result` → `local_resource` items (Claude-hosted files),
 *  - `tool_result` → `image_gallery` items (remote images),
 * plus two defensive shapes not covered by the reference: `image` content
 * blocks (url or base64 sources) and message-level `files`/`attachments`
 * arrays. Every provider id/file path is deduped by `key`.
 */
export function claudeMessageAttachments(
  message: { content?: unknown; files?: unknown; attachments?: unknown } | null | undefined,
  conversationUuid: string | null,
): ClaudeAttachmentDescriptor[] {
  const out: ClaudeAttachmentDescriptor[] = [];
  const seen = new Set<string>();
  const push = (descriptor: ClaudeAttachmentDescriptor | null): void => {
    if (!descriptor || seen.has(descriptor.key)) return;
    seen.add(descriptor.key);
    out.push(descriptor);
  };

  const localResource = (item: ClaudeContentItem): void => {
    const filePath = typeof item.file_path === 'string' ? item.file_path.trim() : '';
    if (!filePath) return;
    const pathName = filePath.split('/').filter(Boolean).at(-1) || null;
    const itemName = typeof item.name === 'string' ? item.name.trim() : '';
    const originalName = itemName && /\.[A-Za-z0-9]{1,10}$/.test(itemName)
      ? itemName
      : pathName || itemName || null;
    void conversationUuid; // context lives on the download call, not the descriptor
    push({
      kind: 'local-resource',
      key: `local:${filePath}`,
      filePath,
      originalName,
      mimeType: typeof item.mime_type === 'string' && item.mime_type ? item.mime_type : 'application/octet-stream',
    });
  };

  const blocks = Array.isArray(message?.content) ? (message?.content as ClaudeContentItem[]) : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') continue;

    // Defensive: user-uploaded / embedded image blocks (url or inline base64).
    if (block.type === 'image') {
      const source = (block.source ?? {}) as Record<string, unknown>;
      const url = typeof source.url === 'string' ? source.url.trim()
        : typeof block.url === 'string' ? block.url.trim() : '';
      const data = typeof source.data === 'string' ? source.data.trim()
        : typeof block.data === 'string' ? block.data.trim() : '';
      const mediaType = typeof source.media_type === 'string' ? source.media_type
        : typeof block.media_type === 'string' ? block.media_type
        : 'image/png';
      if (url) {
        push(claudeRemoteImage({ url, title: 'Image' }));
      } else if (data) {
        push({
          kind: 'inline-image',
          key: `inline:${data.slice(0, 64)}`,
          dataBase64: data,
          originalName: null,
          mimeType: mediaType,
        });
      }
      continue;
    }

    if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;

    for (const raw of block.content as ClaudeContentItem[]) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.type === 'local_resource') {
        localResource(raw);
        continue;
      }
      if (raw.type === 'image_gallery' && Array.isArray(raw.images)) {
        for (const image of raw.images as Array<Record<string, unknown>>) {
          push(claudeRemoteImage(image));
        }
      }
    }
  }

  // Defensive: some payload variants carry file lists at the message level.
  for (const listKey of ['files', 'attachments'] as const) {
    const list = message?.[listKey];
    if (!Array.isArray(list)) continue;
    for (const raw of list as ClaudeContentItem[]) {
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.file_path === 'string') localResource(raw);
      else if (typeof raw.url === 'string') push(claudeRemoteImage({ url: raw.url, title: typeof raw.name === 'string' ? raw.name : undefined }));
    }
  }

  return out;
}

/* ══════════════════════════════ Grok ═══════════════════════════════════════ */

const GROK_ASSET_BASE = 'https://assets.grok.com/';

export type GrokAttachmentDescriptor =
  /** User/generated asset referenced by UUID — resolve via /rest/assets/<id>. */
  | { kind: 'asset'; key: string; assetId: string }
  /** Generated image with a direct assets.grok.com URL (authenticated fetch). */
  | { kind: 'generated-image'; key: string; url: string; assetId: string | null; mimeType: string }
  /** Third-party/search image — best-effort fetch, remote fallback on failure. */
  | { kind: 'search-image'; key: string; url: string }
  /** Rendered/generated file — resolve through conversation files/content. */
  | {
      kind: 'signed-file';
      key: string;
      conversationId: string | null;
      filePath: string;
      originalName: string | null;
      mimeType: string;
    };

function absoluteGrokAssetUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : GROK_ASSET_BASE + trimmed.replace(/^\/+/, '');
}

function grokFileNameFromUrl(value: string, fallback: string | null = null): string | null {
  if (!value) return fallback;
  try {
    const name = new URL(value, GROK_ASSET_BASE).pathname.split('/').filter(Boolean).at(-1);
    return name ? decodeURIComponent(name) : fallback;
  } catch {
    return fallback;
  }
}

/** Parse cardAttachmentsJson entries (strings or already-parsed objects). */
export function parseGrokCards(raw: unknown): Array<Record<string, unknown>> {
  const cards: Array<Record<string, unknown>> = [];
  for (const entry of (Array.isArray(raw) ? raw : []) as unknown[]) {
    if (!entry) continue;
    if (typeof entry === 'object') {
      cards.push(entry as Record<string, unknown>);
      continue;
    }
    if (typeof entry !== 'string') continue;
    try {
      const parsed = JSON.parse(entry) as unknown;
      if (parsed && typeof parsed === 'object') cards.push(parsed as Record<string, unknown>);
    } catch {
      // malformed card json — skip
    }
  }
  return cards;
}

function grokAttachmentFromCard(
  card: Record<string, unknown>,
  conversationId: string | null,
): GrokAttachmentDescriptor | null {
  const imageChunk = (card.image_chunk ?? {}) as Record<string, unknown>;

  if (card.cardType === 'generated_image_card' || imageChunk.imageUrl) {
    const remoteUrl = absoluteGrokAssetUrl(imageChunk.imageUrl);
    if (!remoteUrl) return null;
    const assetId = typeof imageChunk.imageUuid === 'string' ? imageChunk.imageUuid : null;
    return {
      kind: 'generated-image',
      key: `url:${remoteUrl}`,
      url: remoteUrl,
      assetId,
      mimeType: typeof imageChunk.mimeType === 'string' ? imageChunk.mimeType
        : typeof imageChunk.mime_type === 'string' ? imageChunk.mime_type
        : 'image/jpeg',
    };
  }

  const image = (card.image ?? null) as Record<string, unknown> | null;
  if (card.cardType === 'image_card' && image) {
    const remoteUrl = typeof image.original === 'string' && image.original
      ? image.original
      : typeof image.thumbnail === 'string' ? image.thumbnail : null;
    if (!remoteUrl) return null;
    return { kind: 'search-image', key: `url:${remoteUrl}`, url: remoteUrl };
  }

  if (card.type === 'render_file' || card.cardType === 'rendered_file_card') {
    const remoteUrl = absoluteGrokAssetUrl(card.url);
    if (!remoteUrl) return null;
    const originalName = typeof card.file_name === 'string' && card.file_name
      ? card.file_name
      : grokFileNameFromUrl(remoteUrl);
    const filePath = typeof card.file_path === 'string' && card.file_path
      ? card.file_path
      : originalName ? `/${originalName}` : null;
    if (!filePath) return null;
    return {
      kind: 'signed-file',
      key: `file:${filePath}`,
      conversationId,
      filePath,
      originalName,
      mimeType: typeof card.mime_type === 'string' && card.mime_type ? card.mime_type : 'application/octet-stream',
    };
  }

  return null;
}

/**
 * Collect every attachment descriptor for one Grok response turn.
 * Cards first (generated/search images, rendered files), then `fileAttachments`
 * UUIDs that no card already represents — those are resolved through
 * /rest/assets/{assetId} (a user upload may exist ONLY as a UUID).
 */
export function grokTurnAttachments(
  turn: { cardAttachmentsJson?: unknown; fileAttachments?: unknown } | null | undefined,
  conversationId: string | null,
): GrokAttachmentDescriptor[] {
  const cards = parseGrokCards(turn?.cardAttachmentsJson);
  const cardAttachments = cards
    .map(card => grokAttachmentFromCard(card, conversationId))
    .filter((item): item is GrokAttachmentDescriptor => item !== null);

  const coveredAssetIds = new Set(
    cardAttachments
      .map(item => (item.kind === 'generated-image' ? item.assetId : null))
      .filter((id): id is string => typeof id === 'string' && !!id),
  );

  const seenKeys = new Set(cardAttachments.map(item => item.key));
  const out = [...cardAttachments];
  const files = Array.isArray(turn?.fileAttachments) ? turn?.fileAttachments : [];
  for (const raw of files) {
    const assetId = String(raw ?? '').trim();
    if (!assetId || coveredAssetIds.has(assetId)) continue;
    const key = `asset:${assetId}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push({ kind: 'asset', key, assetId });
  }
  return out;
}
