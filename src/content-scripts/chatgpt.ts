/**
 * Content script for ChatGPT conversations — DOM selection & UI injection.
 *
 * Reference: dom-selection.js (stable-id helpers, turn-root matching)
 */

import {
  blobToBase64,
  finalizeAttachmentName,
} from '../core/attachments';
import {
  chatGptAttachmentDescriptors,
  chatGptSandboxDescriptors,
} from '../core/platform-attachments';
import type { ChatGptFileDescriptor, ChatGptSandboxDescriptor } from '../core/platform-attachments';
import type { DownloadResult } from '../core/attachments';
import type { ExtractedAttachment } from '../core/types';

/* ──────────────── stable-id helpers (from reference) ──────────────── */

function isTemporaryId(value: string): boolean {
  return !!value && value.startsWith('request-');
}

function isStableId(value: string): boolean {
  return !!value && value !== 'client-created-root' && !isTemporaryId(value);
}

function selfOrDescendantWithMessageId(element: Element | null): Element | null {
  if (!element) return null;
  if (element.matches?.('[data-message-id]')) return element;
  return element.querySelector('[data-message-id]') || null;
}

function stableMessageIdInElement(element: Element): string | null {
  const messageEl = selfOrDescendantWithMessageId(element);
  const messageId = messageEl?.getAttribute('data-message-id') || null;
  return messageId && !isTemporaryId(messageId) ? messageId : null;
}

function matchingTurnRoot(container: Element, sourceTurnId: string): Element | null {
  if (!container || !sourceTurnId) return null;
  const candidates = container.querySelectorAll('[data-turn-id]');
  for (const c of candidates) {
    if (c.getAttribute('data-turn-id') === sourceTurnId) return c;
  }
  return null;
}

function mountedFallbackRoot(container: Element): Element | null {
  if (!container || !(container instanceof HTMLElement)) return null;
  const semantic = container.querySelector([
    '[data-message-author-role]',
    '[data-testid^="conversation-turn-"]',
    '[data-conversation-screenshot-content]',
    '.markdown',
    'img',
    'video',
    'audio',
  ].join(','));
  if (semantic) {
    return (semantic as HTMLElement).closest('[data-conversation-screenshot-content]') || semantic;
  }
  if ((container.textContent || '').trim()) return container;
  return null;
}

/* ──────────── selection state ───────────────── */

const injectedCheckboxes = new Map<Element, HTMLInputElement>();
const selectedMessages = new Set<string>();

// DOM class names applied to injected elements.
const CB_CLASS = '__kontekst-message-checkbox';
const CB_VISIBLE = '__kontekst-cb-visible'; // show on hover via CSS injection below.

/* ──────────── UI injection (checkbox per turn) ─────────────── */

/** Inject <style> into the page so checkboxes are visible only on hover. */
function injectHoverStyles(): void {
  if ((document.getElementById('__kontekst-cb-styles') as HTMLStyleElement | null)) return;
  const style = document.createElement('style');
  style.id = '__kontekst-cb-styles';
  // By default checkboxes are invisible (width/height collapse).
  // On hover of the turn container they appear at the left edge.
  style.textContent = [
    `.${CB_CLASS}{position:fixed;z-index:9999;opacity:0;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;}`,
    `div[${CB_VISIBLE}] > .${CB_CLASS}{opacity:1;width:26px;height:24px;margin:-7px 8px 0 0;cursor:pointer;pointer-events:auto;}`
  ].join('\n');
  document.head.appendChild(style);
}

/** Build a single checkbox for one message turn. */
function createCheckbox(messageId: string): HTMLInputElement {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true; // default: all selected.
  cb.className = CB_CLASS;
  cb.dataset?.messageId ?? (cb.setAttribute('data-message', messageId));

  cb.addEventListener('change', () => {
    if (cb.checked) {
      selectedMessages.add(messageId);
      cb.classList.add(CB_VISIBLE);
    } else {
      selectedMessages.delete(messageId);
      cb.classList.remove(CB_VISIBLE);
    }
  });

  // Position checkbox inside the turn's top-left corner.
  Object.assign(cb.style, {
    position: 'fixed',
    top: '-9999px',
    left: '-9999px',
    width: '26px',
    height: '24px',
    margin: '0',
    padding: '0',
    cursor: 'pointer',
    backgroundColor: 'transparent',
    border: 'none',
    WebkitAppearance: 'auto' as any, // keep native appearance.
  });

  return cb;
}

/** Find the turn container that owns a given message element. */
function findTurnContainer(msgEl: Element): HTMLElement | null {
  // Second: semantic turn marker used by ChatGPT's React tree.
  const turnMarker = msgEl.closest('[data-testid^="conversation-turn-"]');
  if (turnMarker && (turnMarker instanceof HTMLElement)) return turnMarker;

  // Third: author role div as container when turn markers are missing.
  const authorRole = msgEl.closest('[data-message-author-role]') || msgEl;
  const root = mountedFallbackRoot(authorRole);
  return root instanceof HTMLElement ? root : null;
}

/** Ensure a checkbox is injected for a given message DOM element. */
function ensureCheckboxForElement(msgEl: Element): boolean {
  const messageId = stableMessageIdInElement(msgEl);
  if (!messageId || !isStableId(messageId)) return false;

  const container = findTurnContainer(msgEl);
  if (!container) return false;

  // Already injected?
  if (injectedCheckboxes.has(container)) return true;
  try {
    const cb = createCheckbox(messageId);
    // We need to position the checkbox in a way that survives container
    // scroll — so we store it as a direct child but use 'fixed' positioning.
    container.appendChild(cb);
    selectedMessages.add(messageId);
    cb.classList.add(CB_VISIBLE);
    injectedCheckboxes.set(container, cb);
    return true;
  } catch {
    return false; // DOM may be in an inconsistent state.
  }
}

/* ──────────── scan full page + MutationObserver for streaming ───────── */

function injectForAllVisibleTurns(): void {
  document.querySelectorAll('[data-message-author-role]').forEach(el => {
    if (el instanceof HTMLElement) ensureCheckboxForElement(el);
  });
}

function createObserver(): MutationObserver | null {
  // Find the nearest scrollable conversation wrapper to observe.
  const container = document.querySelector('[data-testid^="conversation-pane"]');
  if (!container) return null;

  let ticking = false;

  const observer = new MutationObserver((mutations) => {
    if (ticking) return; // throttle to one frame.
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      // Scan any newly added children that contain message content.
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          const target = node.querySelector('[data-message-author-role]') || node;
          if (target instanceof HTMLElement && ensureCheckboxForElement(target)) {
            injectedCheckboxes.set(target, null! as any);
          }
        }
      }
    });
  });

  observer.observe(container, { childList: true, subtree: true });
  return observer;
}

/* ──────────── public API (mounted on window to keep chrome API out) ───── */

let mutationObserver: MutationObserver | null = null;

/** Activate selection UI for the current ChatGPT page. */
export function initChatGptSelection(): (() => void) | null {
  const chatPage = document.body?.querySelector('[data-chatgpt]') || document.body?.classList.contains('chatgpt-body');
  if (!chatPage && !document.querySelector('[data-testid^="conversation-pane"]')) return null;

  injectHoverStyles();
  injectForAllVisibleTurns();

  mutationObserver = createObserver();

  // Return cleanup function — popup/background can call it to stop.
  return () => destroyChatGptSelection();
}

/** Remove all injected DOM elements and stop observing changes. */
export function destroyChatGptSelection(): void {
  for (const [el, cb] of injectedCheckboxes) {
    try { el.removeChild(cb as HTMLElement); } catch {}
  }
  injectedCheckboxes.clear();
  mutationObserver?.disconnect();
  mutationObserver = null;

  // Remove the <style> tag.
  const styleEl = document.getElementById('__kontekst-cb-styles');
  styleEl?.removeEventListener && styleEl.remove();

  selectedMessages.clear();
}

/** Get the current set of selected message IDs (for use by the extractor). */
export function getSelectedMessages(): Set<string> {
  return new Set(selectedMessages);
}

/* ──────────── load listener (runs on DOMContentLoaded via manifest) ══ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'kontekst:extract') {
    extractChatGPTData({ includeAttachments: !!message.includeAttachments }).then(data => {
      sendResponse({ success: true, data });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // async response.
  }
  if (message?.type === 'kontekst:init-selection') {
    initChatGptSelection?.();
    sendResponse({ success: true });
    return true;
  }
  if (message?.type === 'kontekst:destroy-selection') {
    destroyChatGptSelection?.();
    sendResponse({ success: true });
    return true;
  }
  return false;
});

/* ──────── REST-API extraction (reference: chatgpt-api.js + conversation.js) ─────
 *
 * The reference exporter does NOT scrape message text from the DOM — it fetches
 * the conversation as JSON from /backend-api/conversation/<id> (auth token from
 * /api/auth/session) and walks the `mapping` tree from `current_node`. The DOM is
 * only used for the checkbox selection UI. Scraping DOM text is the fragile path
 * that breaks whenever ChatGPT changes its markup, so we follow the reference and
 * read the same API the page itself uses. This content script already runs on the
 * chatgpt.com origin, so a relative fetch carries the session cookie.
 * ────────────────────────────────────────────────────────────────────────────── */

interface ApiContent {
  content_type?: string;
  text?: string;
  parts?: unknown[];
}

interface ApiMessage {
  id: string;
  author?: { role?: string };
  content?: ApiContent;
  recipient?: string;
  create_time?: number | string;
  metadata?: Record<string, unknown>;
}

interface ApiNode {
  id: string;
  parent?: string | null;
  message?: ApiMessage;
}

interface ApiConversation {
  current_node?: string;
  mapping?: Record<string, ApiNode>;
  conversation_id?: string;
  title?: string;
  /** Conversation-level signed Estuary URLs (authoritative per file id). */
  safe_urls?: string[];
}

/** Internal content types the reference hides from the export (conversation.js). */
const HIDDEN_CONTENT_TYPES = [
  'reasoning_recap',
  'thoughts',
  'system_error',
  'model_editable_context',
  'computer_initialize_state',
];

/** Mirror of the reference's isVisibleMessage — keep only conversational turns. */
function isApiVisibleMessage(msg: ApiMessage): boolean {
  const role = msg.author?.role;
  const type = msg.content?.content_type || '';
  if (HIDDEN_CONTENT_TYPES.includes(type)) return false;
  if (role === 'user') return true;
  if (role === 'assistant') {
    // Assistant messages addressed to a specific tool are internal plumbing.
    const recipient = typeof msg.recipient === 'string' ? msg.recipient.trim() : '';
    return !recipient || recipient === 'all';
  }
  // tool / system / unknown roles are service records, not conversational text.
  return false;
}

/** Mirror of the reference's textParts + cleanExportText. */
function apiTextParts(msg: ApiMessage): string[] {
  const c = msg.content || {};
  const isUser = msg.author?.role === 'user';
  const clean = (t: string): string =>
    isUser
      ? t
      : t.replaceAll('\uE200memcite\uE201', '').replace(/\uE200cite(?:\uE202[^\uE201]*)*\uE201/g, '');

  const out: string[] = [];
  if (Array.isArray(c.parts)) {
    for (const p of c.parts) {
      if (typeof p !== 'string') continue; // skip multimodal object parts
      const t = clean(p);
      if (t.trim()) out.push(t);
    }
  } else if (typeof c.text === 'string') {
    const t = clean(c.text);
    if (t.trim()) out.push(t);
  }
  return out;
}

/** Mirror of the reference's rawBranchFromCurrent — walk parents to the root. */
function rawBranchFromCurrent(data: ApiConversation): ApiNode[] {
  const out: ApiNode[] = [];
  let id = data.current_node;
  const seen = new Set<string>();
  while (id && id !== 'client-created-root' && !seen.has(id)) {
    seen.add(id);
    const node = data.mapping?.[id];
    if (!node) break;
    out.push(node);
    id = node.parent ?? undefined;
  }
  return out.reverse(); // chronological order
}

/* ──────── attachment extraction (files uploaded into the chat) ─────────────
 *
 * Ported from the reference (attachments.js + chatgpt-api.js
 * downloadAttachmentInPage). Attachments are discovered structurally —
 * `message.metadata.attachments`, file records nested in `message.content`
 * (pasted images live in `multimodal_text` parts as `image_asset_pointer`
 * objects whose `asset_pointer` is `sediment://file_…`), and conversation
 * level `safe_urls` — then normalised to Estuary file ids by
 * chatGptAttachmentDescriptors().
 *
 * Downloads go through
 *
 *   GET /backend-api/files/download/<fileId>
 *
 * with the session Bearer token. That endpoint returns a JSON envelope
 * carrying a signed `download_url`; the media URL is then fetched with the
 * same token. Sandbox artifacts (only present as Markdown links) resolve via
 * /backend-api/conversation/<id>/interpreter/download instead.
 * ────────────────────────────────────────────────────────────────────────── */

/** Metadata envelope returned by the files/interpreter download endpoints. */
interface ChatGptMediaMeta {
  status?: string;
  file_name?: string;
  mime_type?: string;
  mimeType?: string;
  content_type?: string;
  download_url?: string;
  downloadUrl?: string;
  url?: string;
  signed_url?: string;
  signedUrl?: string;
  [key: string]: unknown;
}

/** Resolve any ChatGPT metadata envelope to its signed media URL. */
function mediaUrlFromMeta(meta: ChatGptMediaMeta | null | undefined): string | null {
  if (!meta) return null;
  const url = meta.download_url || meta.downloadUrl || meta.url || meta.signed_url || meta.signedUrl;
  return typeof url === 'string' && url ? url : null;
}

/** Best human-readable name inside a metadata object (preferred keys first). */
function filenameFromMetaObject(value: unknown): string | null {
  const seen = new WeakSet<object>();
  const preferred = ['title', 'original_name', 'originalName', 'filename', 'file_name'];
  const clean = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    // Internal ids are not names (reference cleanName behaviour).
    return t && !t.startsWith('file_') ? t : null;
  };

  const visit = (obj: unknown): string | null => {
    if (!obj || typeof obj !== 'object' || seen.has(obj as object)) return null;
    seen.add(obj as object);
    const rec = obj as Record<string, unknown>;
    for (const key of preferred) {
      const found = clean(rec[key]);
      if (found) return found;
    }
    const generic = clean(rec.name);
    if (generic) return generic;
    for (const child of Object.values(rec)) {
      if (child && typeof child === 'object') {
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  };

  return visit(value);
}

/** Parse Content-Disposition: filename*=UTF-8''… / filename="…". */
function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const clean = (v: string): string | null => {
    const t = v.trim().replace(/^"|"$/g, '');
    return t && !t.startsWith('file_') ? t : null;
  };

  const star = value.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i);
  if (star) {
    let v = star[1].trim().replace(/^"|"$/g, '');
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    const cleaned = clean(v);
    if (cleaned) return cleaned;
  }

  const plain = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  if (plain) {
    const cleaned = clean((plain[1] || plain[2] || '').trim());
    if (cleaned) return cleaned;
  }
  return null;
}

function basenameFromUrl(value: string): string | null {
  try {
    const segments = new URL(value, location.href).pathname.split('/').filter(Boolean);
    return segments.length ? decodeURIComponent(segments[segments.length - 1]) : null;
  } catch {
    return null;
  }
}

/** Fetch a resolved media URL with the session token and repack its bytes. */
async function fetchChatGptMedia(
  mediaUrl: string,
  accessToken: string,
  fallbackName: string | null,
  fallbackType: string | null,
): Promise<DownloadResult> {
  let response: Response;
  try {
    response = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: 'include',
    });
  } catch (err) {
    return { attachment: null, error: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) return { attachment: null, error: `HTTP ${response.status}` };

  const name = fallbackName ||
    filenameFromContentDisposition(response.headers.get('content-disposition')) ||
    basenameFromUrl(response.url || mediaUrl);
  const blob = await response.blob().catch(() => null);
  if (!blob) return { attachment: null, error: 'body read failed' };

  const contentType = response.headers.get('content-type') || '';
  const mimeType = fallbackType && fallbackType !== 'application/octet-stream'
    ? fallbackType
    : blob.type || contentType || null;
  return {
    attachment: {
      filename: finalizeAttachmentName(name, mimeType),
      mimeType,
      dataBase64: await blobToBase64(blob),
    },
  };
}

/** Download one ordinary ChatGPT file (uploaded doc or pasted/generated image). */
async function downloadChatGptFile(
  descriptor: ChatGptFileDescriptor,
  accessToken: string,
): Promise<DownloadResult> {
  let name = descriptor.originalName;
  let type = descriptor.mimeType;
  let mediaUrl = descriptor.signedUrl;

  if (!mediaUrl) {
    if (!descriptor.fileId) return { attachment: null, error: 'attachment id is missing' };

    let response: Response;
    try {
      // NB: the reference endpoint is files/download/<id> — NOT files/<id>/download.
      response = await fetch(`/backend-api/files/download/${encodeURIComponent(descriptor.fileId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        credentials: 'include',
      });
    } catch (err) {
      return { attachment: null, error: `network error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!response.ok) return { attachment: null, error: `HTTP ${response.status}` };

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      // Envelope shape: { download_url, mime_type, … } → signed media URL.
      const meta = (await response.json().catch(() => null)) as ChatGptMediaMeta | null;
      mediaUrl = mediaUrlFromMeta(meta);
      name = name || filenameFromMetaObject(meta);
      type = type || meta?.mime_type || meta?.mimeType || meta?.content_type || null;
      if (!mediaUrl) return { attachment: null, error: 'no download_url in files API response' };
    } else {
      // Direct bytes — repack the body we already have.
      const blob = await response.blob().catch(() => null);
      if (!blob) return { attachment: null, error: 'body read failed' };
      const mimeType = type || blob.type || contentType || null;
      return {
        attachment: {
          filename: finalizeAttachmentName(name, mimeType),
          mimeType,
          dataBase64: await blobToBase64(blob),
        },
      };
    }
  }

  return fetchChatGptMedia(mediaUrl, accessToken, name, type);
}

/** Resolve a sandbox artifact via interpreter/download, then fetch its bytes. */
async function downloadChatGptSandboxFile(
  descriptor: ChatGptSandboxDescriptor,
  conversationId: string,
  messageId: string,
  accessToken: string,
): Promise<DownloadResult> {
  const query = new URLSearchParams({
    message_id: messageId,
    sandbox_path: descriptor.sandboxPath,
    download_intent: 'true',
  });

  let response: Response;
  try {
    response = await fetch(
      `/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${query}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, credentials: 'include' },
    );
  } catch (err) {
    return { attachment: null, error: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) return { attachment: null, error: `interpreter/download HTTP ${response.status}` };

  const meta = (await response.json().catch(() => null)) as ChatGptMediaMeta | null;
  if (meta?.status && meta.status !== 'success') {
    return { attachment: null, error: `interpreter/download status: ${String(meta.status)}` };
  }
  const mediaUrl = mediaUrlFromMeta(meta);
  if (!mediaUrl) return { attachment: null, error: 'no download_url in interpreter response' };

  const name = descriptor.originalName || filenameFromMetaObject(meta);
  const type = meta?.mime_type || meta?.mimeType || null;
  return fetchChatGptMedia(mediaUrl, accessToken, name, type);
}

/**
 * Extract the conversation via the REST API (same call the ChatGPT page makes)
 * and normalise it into the { role, content, messageId }[] shape the popup and
 * background already expect. When includeAttachments is set, uploaded files
 * and pasted images are downloaded and carried alongside as base64.
 */
async function extractChatGPTData(
  options: { includeAttachments?: boolean } = {},
): Promise<Record<string, unknown>> {
  // 1. Conversation id from the URL (same regex as the reference).
  const match = location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) {
    throw new Error('Not a ChatGPT conversation page (no /c/<uuid> in the URL).');
  }
  const conversationId = match[0];

  // 2. Auth token from /api/auth/session (relative fetch → chatgpt.com cookies).
  const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
  const session = await sessionRes.json().catch(() => null);
  const accessToken: string | null = session?.accessToken || null;
  if (!accessToken) {
    throw new Error('Cannot read ChatGPT session token — are you logged in to ChatGPT?');
  }

  // 3. Fetch the conversation graph (current_node + mapping).
  const res = await fetch(`/backend-api/conversation/${conversationId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Conversation fetch failed (HTTP ${res.status}).`);
  const data: ApiConversation = await res.json();

  if (!data || typeof data.current_node !== 'string' || !data.mapping) {
    throw new Error('Unexpected conversation payload shape.');
  }

  // 4. Walk the branch, keep visible messages, join their text parts.
  const branch = rawBranchFromCurrent(data);
  const safeUrls = Array.isArray(data.safe_urls)
    ? data.safe_urls.filter((url): url is string => typeof url === 'string')
    : [];
  const messages: Array<{
    role: string;
    content: string;
    messageId: string;
    attachments?: ExtractedAttachment[];
  }> = [];
  const attachmentErrors: string[] = [];
  let hiddenOrBlank = 0;
  for (const node of branch) {
    const msg = node.message;
    if (!msg || !isApiVisibleMessage(msg)) {
      hiddenOrBlank++;
      continue;
    }
    const role = msg.author?.role === 'user' ? 'user' : 'assistant';
    const textParts = apiTextParts(msg);
    const content = textParts.join('\n\n');

    // Download this message's attachments (uploaded files, pasted images and
    // sandbox artifacts) when the popup asked for them. Computed BEFORE the
    // blank-content check: an image-only message carries no text parts, so a
    // text-first skip would silently drop its files.
    let attachments: ExtractedAttachment[] | undefined;
    if (options.includeAttachments) {
      const fileDescriptors = chatGptAttachmentDescriptors(msg, safeUrls);
      const sandboxDescriptors = chatGptSandboxDescriptors(textParts);
      if (fileDescriptors.length || sandboxDescriptors.length) {
        console.log('[KONTEKST] chatgpt attachments — msg', msg.id, JSON.stringify({
          files: fileDescriptors.map(d => ({ id: d.fileId, name: d.originalName, mime: d.mimeType, signed: !!d.signedUrl })),
          sandbox: sandboxDescriptors.map(s => s.sandboxPath),
        }));
      }

      const downloaded: ExtractedAttachment[] = [];
      for (const descriptor of fileDescriptors) {
        const { attachment, error } = await downloadChatGptFile(descriptor, accessToken);
        if (attachment) downloaded.push(attachment);
        else attachmentErrors.push(`${descriptor.originalName ?? descriptor.fileId}: ${error}`);
      }
      for (const sandbox of sandboxDescriptors) {
        const { attachment, error } = await downloadChatGptSandboxFile(
          sandbox,
          conversationId,
          msg.id || node.id,
          accessToken,
        );
        if (attachment) downloaded.push(attachment);
        else attachmentErrors.push(`${sandbox.originalName ?? sandbox.sandboxPath}: ${error}`);
      }
      if (downloaded.length) attachments = downloaded;
    }

    if (!content.trim() && !attachments) {
      hiddenOrBlank++;
      continue;
    }

    messages.push({ role, content, messageId: msg.id || node.id, ...(attachments ? { attachments } : {}) });
  }

  return {
    platform: 'chatgpt',
    conversationId: data.conversation_id || null,
    title: typeof data.title === 'string' ? data.title : '',
    messages,
    pageCount: messages.length,
    extractedAt: new Date().toISOString(),
    ...(attachmentErrors.length ? { attachmentErrors } : {}),
    diagnostics: {
      source: 'rest-api',
      conversationId,
      branchNodes: branch.length,
      extracted: messages.length,
      hiddenOrBlank,
      href: location.href,
    },
  };
}

/* ──────────── auto-mount on first paint ══════════ */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initChatGptSelection());
} else {
  initChatGptSelection();
}

console.log('[KONTEKST] ChatGPT content script loaded — selection UI active.');
