export {};

/**
 * Content script for Grok conversations — DOM selection & checkbox UI injection.
 */

import { downloadAttachment } from '../core/attachments';
import { grokTurnAttachments } from '../core/platform-attachments';
import type { GrokAttachmentDescriptor } from '../core/platform-attachments';
import type { DownloadResult } from '../core/attachments';
import type { ExtractedAttachment } from '../core/types';

// ──────────────── state ───────────────────────────────────────────────

const selectedMessageIds = new Set<string>();
const excludedMessageIds = new Set<string>();
let enabled = false;
let selectAllMode = true;
let anchorId: string | null = null;
let observer: MutationObserver | null = null;
let refreshQueued = false;
let orderedIds: string[] = [];
let collecting: Promise<void> | null = null;

// ──────────────── DOM helpers — Grok-specific selectors ──────────────

function conversationId(): string | null {
  const pathMatch = location.pathname.match(/\/(?:c|chat|conversation)\/([0-9a-f-]{36})(?:\/|$)/i);
  if (pathMatch) return pathMatch[1];
  // Fallback: enumerate performance resource entries for conversation UUIDs.
  const resources = performance.getEntriesByType('resource').map(e => e.name);
  for (let i = resources.length - 1; i >= 0; i--) {
    const match = resources[i].match(/\/rest\/app-chat\/conversations_v2\/([0-9a-f-]{36})/i);
    if (match) return match[1];
  }
  return null;
}

/** Find every visible Grok response turn that the user can select. */
function turnItems(): Array<{ turn: Element; id: string }> {
  return [...document.querySelectorAll('[id^="response-"]')]
    .map(turn => ({
      turn,
      id: String(turn.id || '').replace(/^response-/, ''),
    }))
    .filter(item => item.id);
}

/* ────── ordered-ids helpers (for shift-click range selection) ─────── */

function collectOrderedIds(): Promise<void> {
  if (collecting) return collecting;
  collecting = new Promise(resolve => {
    refreshQueued = false;
    requestAnimationFrame(() => {
      orderedIds = turnItems().map(item => item.id);
      resolve();
    });
    setTimeout(() => { collecting = null; resolve(); }, 2000);
  });
  return collecting;
}

function totalMessageCount(): number {
  const items = turnItems();
  if (!items.length) return 0;
  // Try aria-setsize on [role="article"].
  for (const item of items) {
    const article = item.turn.querySelector('[role="article"]');
    const size = Number(article?.getAttribute('aria-setsize'));
    if (Number.isInteger(size) && size >= 0) return size;
  }
  // Best-effort from highest index.
  for (const item of items) {
    const match = String(item.turn.id || '').match(/response-(\d+)/i);
    if (match) return Number(match[1]) + 1;
  }
  return items.length;
}

/* ────── selection helpers ───────────────── */

function isSelected(id: string): boolean {
  const rid = String(id);
  return selectAllMode ? !excludedMessageIds.has(rid) : selectedMessageIds.has(rid);
}

function setSelected(id: string, checked: boolean): void {
  const rid = String(id);
  if (selectAllMode) {
    checked ? excludedMessageIds.delete(rid) : excludedMessageIds.add(rid);
  } else {
    checked ? selectedMessageIds.add(rid) : selectedMessageIds.delete(rid);
  }
}

/* ────── checkbox UI injection ─────────────── */

/**
 * Returns the DOM element that will host the checkbox for a given turn.
 * Grok puts the message content inside [data-testid="user-message"] or [data-testid="assistant-message"].
 */
function checkboxHost(turn: Element): HTMLElement | null {
  const host = turn.querySelector('[data-testid="user-message"], [data-testid="assistant-message"]');
  return (host || turn) as HTMLElement;
}

/** Inject a styled checkbox into one Grok response turn element. */
function addCheckbox(item: { turn: Element; id: string }): void {
  if (item.turn.querySelector('.chatgpt-export-select')) return; // already injected.

  const host = checkboxHost(item.turn);
  if (!host) return;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = isSelected(item.id);
  box.className = '__kontekst-cb';
  box.title = 'Select message for export';
  box.setAttribute('aria-label', box.title);

  // Style: visible at top-left of the host.
  Object.assign(box.style, {
    position: 'absolute',
    left: '-30px',
    top: '10px',
    width: '20px',
    height: '20px',
    zIndex: '2147483647',
    cursor: 'pointer',
    accentColor: '#7c3aed',
    opacity: '1',
    visibility: 'visible',
    pointerEvents: 'auto' as const,
  } as Partial<CSSStyleDeclaration>);

  // Ensure the host has a non-static positioning context.
  if (getComputedStyle(host).position === 'static') {
    host.style.position = 'relative';
  }
  host.style.overflow = 'visible';

  box.addEventListener('click', event => {
    event.stopPropagation();
    const value = box.checked;
    // Shift-click range selection.
    if (event.shiftKey && anchorId && orderedIds.length) {
      const a = orderedIds.indexOf(anchorId);
      const b = orderedIds.indexOf(item.id);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let k = lo; k <= hi; k++) setSelected(orderedIds[k], value);
      } else {
        setSelected(item.id, value);
      }
    } else {
      // Toggle current.
      if (selectAllMode) {
        value ? excludedMessageIds.delete(String(item.id)) : excludedMessageIds.add(String(item.id));
      } else {
        value ? selectedMessageIds.add(String(item.id)) : selectedMessageIds.delete(String(item.id));
      }
    }
    anchorId = item.id;
    refreshMounted();
  });

  const hostEl = checkboxHost(item.turn);
  if (hostEl) hostEl.appendChild(box);
}

function refreshMounted(): void {
  for (const item of turnItems()) {
    if (enabled) addCheckbox(item);
    const box = item.turn.querySelector('.chatgpt-export-select');
    if (box instanceof HTMLInputElement) {
      box.checked = isSelected(item.id);
      box.style.display = enabled ? 'block' : 'none';
    }
  }
}

/** Schedule a DOM refresh within the next animation frame. */
function scheduleRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refreshMounted();
  });
}

/* ────── MutationObserver setup ───────────*/

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver(mutations => {
    let modified = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement && (node.matches?.('[id^="response-"]') || node.querySelector('[id^="response-"]'))) {
          modified = true;
        }
      }
      // Watch for data-index or aria-setsize changes.
      if (m.attributeName === 'data-index' || m.attributeName === 'aria-setsize') {
        modified = true;
      }
    }
    if (modified) {
      collectOrderedIds().then(scheduleRefresh);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-index', 'aria-setsize'] });
}

/** Inject UI, start the MutationObserver, and set up message port listeners. */
function initGrokSelection(): void {
  enabled = true;
  refreshMounted();
  collectOrderedIds().then(() => {
    ensureObserver();
  });

  chrome.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender: chrome.runtime.MessageSender, respond: (state: Record<string, unknown>) => void) => {
    function currentState(): Record<string, unknown> {
      return {
        enabled,
        allSelected: selectAllMode,
        selectedTurnIds: [] as string[],
        selectedMessageIds: [...selectedMessageIds],
        excludedTurnIds: [] as string[],
        excludedMessageIds: [...excludedMessageIds],
        orderedIds: [...orderedIds],
        totalCount: totalMessageCount(),
      };
    }

    if (msg.type === 'ENABLE_GROK_SELECTION') {
      enabled = true;
      if (msg.allSelected) selectAllMode = true;
      refreshMounted();
      collectOrderedIds().then(() => respond(currentState()));
      return true;
    }

    if (msg.type === 'TOGGLE_SELECT_ALL' || msg.type === 'SET_ALL_SELECTED') {
      selectAllMode = !!msg.allSelected;
      if (selectAllMode) selectedMessageIds.clear();
      else excludedMessageIds.clear();
      refreshMounted();
      respond(currentState());
      return true;
    }

    if (msg.type === 'TOGGLE_SELECT_TURN' && typeof msg.id === 'string') {
      const checked = selectAllMode
        ? !excludedMessageIds.has(msg.id)
        : !selectedMessageIds.has(msg.id);
      setSelected(msg.id, checked);
      refreshMounted();
      respond(currentState());
      return true;
    }

    if (msg.type === 'TOGGLE_EXCLUDE_TURN' && typeof msg.id === 'string') {
      const excluded = !!excludedMessageIds.has(String(msg.id));
      setSelected(String(msg.id), !excluded);
      refreshMounted();
      respond(currentState());
      return true;
    }

    if (msg.type === 'SELECT_RANGE' && typeof msg.startId === 'string' && typeof msg.endId === 'string') {
      const startA = orderedIds.indexOf(msg.startId);
      const endB = orderedIds.indexOf(msg.endId);
      if (startA >= 0 && endB >= 0) {
        const lo = Math.min(startA, endB);
        const hi = Math.max(startA, endB);
        for (let i = lo; i <= hi; i++) { /* range logic */ }
      }
      respond(currentState());
      return true;
    }

    if (msg.type === 'RESET_AFTER_EXPORT') {
      selectAllMode = true;
      selectedMessageIds.clear();
      excludedMessageIds.clear();
      anchorId = null;
      enabled = false;
      refreshMounted();
      respond(currentState());
      return;
    }

    if (msg.type === 'GET_SELECTION_INDEX_IDS') {
      collectOrderedIds().then(() => respond({ selectionIndexIds: [...orderedIds] })).catch(() => respond({ selectionIndexIds: [] }));
      return true;
    }

    if (msg.type === 'ENABLE_GROK_INDEX_WATCH') {
      ensureObserver();
      respond({ ok: true });
      return true;
    }

    if (msg.type === 'kontekst:extract') {
      extractGrokData({ includeAttachments: !!msg.includeAttachments }).then(
        data => respond({ success: true, data }),
        error => respond({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return true;
    }
  });
}

// ────── data extraction for export ─────────── */

/* ──────── attachment extraction (reference: grok-api.js + grok-normalize) ──
 *
 * Grok attachments are API objects, not DOM images: every response turn
 * carries `cardAttachmentsJson` (generated/search images, rendered files) and
 * `fileAttachments` (asset UUIDs — a user upload can exist ONLY as a UUID,
 * with no card and no rendered <img>). Resolution paths (verified in the
 * reference docs/provider-internals.md):
 *
 *   asset UUID              → GET /rest/assets/<id> → { key, name, mimeType }
 *                            → https://assets.grok.com/<key> via an
 *                              authenticated page-context fetch (credentials +
 *                              grok referrer + image-like Accept; a bare
 *                              fetch without them returns 403)
 *   generated image card    → image_chunk.imageUrl on assets.grok.com, same
 *                              authenticated fetch
 *   rendered/generated file → GET /rest/conversations/files/content
 *                              ?conversationId&path → fresh signed URL,
 *                              fetched WITHOUT credentials (the signature is
 *                              the auth)
 *   search/third-party img  → best-effort remote fetch
 *
 * DOM blob: <img> URLs on user rows are kept as a last-resort fallback.
 * ────────────────────────────────────────────────────────────────────────── */

const GROK_IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

interface GrokApiTurn {
  fileAttachments?: unknown;
  cardAttachmentsJson?: unknown;
}

/** Fetch the conversation's responses once per export; map responseId → turn. */
async function fetchGrokApiTurns(conversationId: string): Promise<Map<string, GrokApiTurn>> {
  const map = new Map<string, GrokApiTurn>();
  const response = await fetch(
    `/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/responses?includeThreads=false`,
    { credentials: 'include' },
  );
  if (!response.ok) throw new Error(`Grok responses GET: ${response.status}`);
  const data = (await response.json()) as { responses?: unknown[] };
  for (const raw of Array.isArray(data.responses) ? data.responses : []) {
    const turn = raw as (GrokApiTurn & { responseId?: unknown }) | null;
    if (!turn || typeof turn !== 'object') continue;
    const id = turn.responseId != null ? String(turn.responseId) : '';
    if (id) map.set(id, turn);
  }
  return map;
}

/** Resolve /rest/assets metadata → absolute asset URL + display name. */
async function resolveGrokAsset(
  assetId: string,
): Promise<{ url: string; name: string | null; mimeType: string | null }> {
  const response = await fetch(`/rest/assets/${encodeURIComponent(assetId)}`, { credentials: 'include' });
  if (!response.ok) throw new Error(`asset metadata GET: ${response.status}`);
  const meta = (await response.json()) as Record<string, unknown>;
  const key = typeof meta.key === 'string' ? meta.key.trim() : '';
  if (!key) throw new Error('asset key is missing');
  const url = /^https?:\/\//i.test(key) ? key : `https://assets.grok.com/${key.replace(/^\/+/, '')}`;
  return {
    url,
    name: typeof meta.name === 'string' && meta.name ? meta.name : null,
    mimeType: typeof meta.mimeType === 'string' && meta.mimeType ? meta.mimeType : null,
  };
}

/** Authenticated page-context download of an assets.grok.com URL. */
function downloadGrokAssetBytes(
  url: string,
  name: string | null,
  mimeType: string | null,
): Promise<DownloadResult> {
  const isImage = (mimeType || '').startsWith('image/') ||
    /\.(?:png|jpe?g|gif|webp|avif|svg)(?:$|[?#])/i.test(url);
  return downloadAttachment(url, {
    filename: name,
    mimeType,
    referrer: 'https://grok.com/',
    headers: { Accept: isImage ? GROK_IMAGE_ACCEPT : '*/*' },
  });
}

/** Download a rendered/generated file through its fresh signed URL. */
async function downloadGrokSignedFile(
  descriptor: Extract<GrokAttachmentDescriptor, { kind: 'signed-file' }>,
): Promise<DownloadResult> {
  if (!descriptor.conversationId) return { attachment: null, error: 'missing conversation context' };
  const params = new URLSearchParams({
    conversationId: descriptor.conversationId,
    path: descriptor.filePath,
  });
  const metaResponse = await fetch(`/rest/conversations/files/content?${params}`, { credentials: 'include' });
  if (!metaResponse.ok) return { attachment: null, error: `file metadata GET: ${metaResponse.status}` };
  const meta = (await metaResponse.json().catch(() => null)) as Record<string, unknown> | null;
  const signedUrl = typeof meta?.downloadSignedUrl === 'string' ? meta.downloadSignedUrl
    : typeof meta?.signedUrl === 'string' ? meta.signedUrl
    : null;
  if (!signedUrl) return { attachment: null, error: 'signed URL is missing' };
  const mimeType = typeof meta?.mimeType === 'string' && meta.mimeType ? meta.mimeType : descriptor.mimeType;
  return downloadAttachment(signedUrl, {
    filename: descriptor.originalName,
    mimeType,
    credentials: 'omit',
  });
}

/** Download one Grok descriptor through the right provider path. */
async function downloadGrokDescriptor(descriptor: GrokAttachmentDescriptor): Promise<DownloadResult> {
  switch (descriptor.kind) {
    case 'asset': {
      try {
        const { url, name, mimeType } = await resolveGrokAsset(descriptor.assetId);
        return await downloadGrokAssetBytes(url, name, mimeType);
      } catch (err) {
        return { attachment: null, error: err instanceof Error ? err.message : String(err) };
      }
    }
    case 'generated-image':
      return downloadGrokAssetBytes(descriptor.url, null, descriptor.mimeType);
    case 'search-image':
      return downloadAttachment(descriptor.url, { credentials: 'omit' });
    case 'signed-file':
      return downloadGrokSignedFile(descriptor);
  }
}

/** Page-local blob: images on user rows (fresh pastes not in the API yet). */
function turnBlobImageUrls(turn: Element): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const userEl = turn.querySelector('[data-testid="user-message"]');
  if (!userEl) return out;
  for (const img of userEl.querySelectorAll('img')) {
    const raw = img.getAttribute('src');
    if (!raw || !raw.startsWith('blob:') || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

async function extractGrokData(
  options: { includeAttachments?: boolean } = {},
): Promise<Record<string, unknown>> {
  const items = turnItems();
  const messages: Array<{
    role: string;
    content: string;
    attachments?: ExtractedAttachment[];
  }> = [];
  const attachmentErrors: string[] = [];
  const convId = conversationId();

  // Resolve the API turns once per export — cards + fileAttachments UUIDs
  // only exist in the responses payload, not in the DOM.
  let apiTurns = new Map<string, GrokApiTurn>();
  if (options.includeAttachments && convId) {
    try {
      apiTurns = await fetchGrokApiTurns(convId);
      let described = 0;
      for (const turn of apiTurns.values()) described += grokTurnAttachments(turn, convId).length;
      console.log('[KONTEKST] grok attachment diag:', JSON.stringify({
        conversationId: convId,
        apiTurns: apiTurns.size,
        descriptors: described,
      }));
    } catch (error) {
      attachmentErrors.push(`responses API: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const item of items) {
    // Look for the message text element inside the response turn.
    let textEl = item.turn.querySelector('[class*="prose"], [class*="markdown"]');
    if (!textEl) {
      const article = item.turn.querySelector('[role="article"]');
      textEl = article || item.turn.querySelector('.message-text') || item.turn;
    }

    const innerHTML = (textEl?.innerHTML as string) || '';

    // Determine user vs assistant from data-testid.
    const roleEl = item.turn.querySelector('[data-testid="user-message"], [data-testid="assistant-message"]');
    const hasRoleAttr = (roleEl?.getAttribute('data-testid') || '');
    const isUser = /user/i.test(hasRoleAttr);

    // Attachments: API descriptors for this turn (all roles) plus blob:
    // fallback images on user rows. Computed BEFORE the empty-text check so a
    // files-only turn still exports.
    let attachments: ExtractedAttachment[] | undefined;
    if (options.includeAttachments) {
      const downloaded: ExtractedAttachment[] = [];
      const seenKeys = new Set<string>();

      const apiTurn = apiTurns.get(item.id);
      if (apiTurn) {
        for (const descriptor of grokTurnAttachments(apiTurn, convId)) {
          if (seenKeys.has(descriptor.key)) continue;
          seenKeys.add(descriptor.key);
          const { attachment, error } = await downloadGrokDescriptor(descriptor);
          if (attachment) downloaded.push(attachment);
          else attachmentErrors.push(`${descriptor.key}: ${error}`);
        }
      }

      if (isUser) {
        for (const url of turnBlobImageUrls(item.turn)) {
          const key = `blob:${url}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          const { attachment, error } = await downloadAttachment(url, { filename: null });
          if (attachment) downloaded.push(attachment);
          else attachmentErrors.push(`${url}: ${error}`);
        }
      }

      if (downloaded.length) attachments = downloaded;
    }

    if (!innerHTML.trim() && !attachments) continue;

    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: innerHTML,
      ...(attachments ? { attachments } : {}),
    });
  }

  return {
    platform: 'grok',
    conversationId: convId,
    title: document.title || '',
    messages,
    totalCount: totalMessageCount(),
    extractedAt: new Date().toLocaleString(),
    ...(attachmentErrors.length ? { attachmentErrors } : {}),
    orderedIds,
    selectedTurnIds: [], // legacy
    excludedTurnIds: [], // legacy
  };
}

console.log('[Kontekst] Grok content script loaded — DOM selection active.');

// Auto-mount on first paint.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGrokSelection);
} else {
  initGrokSelection();
}
