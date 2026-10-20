export {};

/**
 * Content script for Claude conversations — DOM selection & checkbox UI injection.
 */

import { downloadAttachment, finalizeAttachmentName } from '../core/attachments';
import { claudeMessageAttachments } from '../core/platform-attachments';
import type { ClaudeAttachmentDescriptor } from '../core/platform-attachments';
import type { DownloadResult } from '../core/attachments';
import type { ExtractedAttachment } from '../core/types';

// ──────────────── state ───────────────────────────────────────────────

const selectedMessageIds = new Set<string>();
const excludedMessageIds = new Set<string>();
let enabled = false;
let selectAllMode = true;
let anchorIndex: number | null = null;
let observer: MutationObserver | null = null;
let refreshQueued = false;

// Row IDs use the "claude-index:" namespace for disambiguation.
const rowId = (index: number): string => `claude-index:${index}`;

/* ────── DOM helpers — targeted to Claude's transcript rows ─────────── */

function conversationId(): string | null {
  const match = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
  return match ? match[1] : null;
}

/** Find every visible transcript row that the user can select individually. */
function rows(): Array<{ row: HTMLElement; index: number }> {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="transcript-row"][data-index]')]
    .map(row => ({
      row,
      index: Number(row.getAttribute('data-index')) || -1,
    }))
    .filter(item => Number.isInteger(item.index) && item.index >= 0);
}

/** Total count of conversation messages (from aria-setsize or best-effort). */
function totalCount(): number {
  for (const { row } of rows()) {
    const article = row.querySelector('[role="article"][aria-setsize]');
    const size = Number(article?.getAttribute('aria-setsize'));
    if (Number.isInteger(size) && size >= 0) return size;
  }
  return rows().reduce((max, item) => Math.max(max, item.index + 1), 0);
}

/* ────── selection helpers ───────────────── */

function isSelected(index: number): boolean {
  const id = rowId(index);
  return selectAllMode ? !excludedMessageIds.has(id) : selectedMessageIds.has(id);
}

function setSelected(index: number, checked: boolean): void {
  const id = rowId(index);
  if (selectAllMode) {
    checked ? excludedMessageIds.delete(id) : excludedMessageIds.add(id);
  } else {
    checked ? selectedMessageIds.add(id) : selectedMessageIds.delete(id);
  }
}

/* ────── checkbox injection ─────────────── */

/**
 * Returns the DOM element that will host the checkbox for a given row.
 * Claude puts the message content inside a [role="article"] — use as host,
 * falling back to the row container itself.
 */
function checkboxHost(row: HTMLElement): HTMLElement | null {
  return (row.querySelector('[role="article"]') || row) as HTMLElement;
}

/** Inject a styled checkbox into one transcript row element. */
function addCheckbox(item: { row: HTMLElement; index: number }): void {
  // NB: class selector needs the leading '.' — without it this is a tag-name
  // query for <__kontekst-cb>, which never matches, so the guard below would
  // fail and every refresh would append another checkbox.
  if (item.row.querySelector('._kontekst-cb')) return; // already injected.

  const host = checkboxHost(item.row);
  if (!host) return;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = isSelected(item.index);
  box.className = '__kontekst-cb';
  box.title = 'Select message for export';
  box.setAttribute('aria-label', box.title);

  // Style: visible at top-left of the host <article>.
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
  });

  // Ensure the host has a non-static positioning context.
  if (getComputedStyle(host).position === 'static') {
    host.style.position = 'relative';
  }
  host.style.overflow = 'visible';

  box.addEventListener('click', event => {
    event.stopPropagation();
    const checked = !!box.checked;
    if (event.shiftKey && anchorIndex != null) {
      const lo = Math.min(anchorIndex, item.index);
      const hi = Math.max(anchorIndex, item.index);
      for (let i = lo; i <= hi; i++) setSelected(i, checked);
    } else {
      setSelected(item.index, checked);
    }
    anchorIndex = item.index;
    refreshMounted();
  });

  host.appendChild(box);
}

/* ────── live refresh (debounced + RAF) ─ */

function refreshMounted(): void {
  for (const item of rows()) {
    if (enabled) addCheckbox(item);
    const box = item.row.querySelector('._kontekst-cb');
    if (box instanceof HTMLInputElement) {
      box.checked = isSelected(item.index);
      box.style.display = enabled ? 'block' : 'none';
    }
  }
}

function scheduleRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refreshMounted();
  });
}

/* ────── MutationObserver — streaming UI ─ */

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-index', 'aria-setsize'],
  });
}

/* ────── query handlers (popup ↔ content) ─ */

function currentState(): Record<string, unknown> {
  const total = totalCount();
  const selected = selectAllMode
    ? Math.max(0, total - excludedMessageIds.size)
    : [...selectedMessageIds].filter(id => {
        const idx = Number(id.slice('claude-index:'.length));
        return Number.isInteger(idx) && idx >= 0 && idx < total;
      }).length;
  return { total, selected, enabled };
}

function selectionIndexSnapshot(): Record<string, unknown> {
  return {
    conversationId: conversationId(),
    ids: rows().map(item => rowId(item.index)),
    temporaryIds: [],
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'kontekst:get-info') {
    refreshMounted();
    respond({
      title: document.title.replace(/\s*[|–-]\s*Claude.*$/i, ''),
      ...currentState(),
    } as Record<string, unknown>);
    return true;
  }

  if (msg.type === 'kontekst:toggle-selection-ui') {
    enabled = !enabled;
    ensureObserver();
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontekst:select-all') {
    selectAllMode = true;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    anchorIndex = null;
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontekst:select-none') {
    selectAllMode = false;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    anchorIndex = null;
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontekst:get-selection') {
    refreshMounted();
    respond({
      selectAll: selectAllMode,
      selectedTurnIds: [] as string[],
      selectedMessageIds: [...selectedMessageIds],
      excludedTurnIds: [] as string[],
      excludedMessageIds: [...excludedMessageIds],
      legacyTurnContexts: [] as Array<unknown>,
      orderedIds: Array.from({ length: totalCount() }, (_, i) => rowId(i)),
    });
    return true;
  }

  if (msg.type === 'kontekst:reset-after-export') {
    selectAllMode = true;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    anchorIndex = null;
    enabled = false;
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontekst:get-selection-index-ids') {
    respond(selectionIndexSnapshot());
    return true;
  }

  if (msg.type === 'kontekst:enable-selection-index-watch') {
    ensureObserver();
    respond({ ok: true });
    return true;
  }

  // Existing extract handler — re-exports as needed.
  if (msg.type === 'kontekst:extract') {
    extractClaudeData({ includeAttachments: !!msg.includeAttachments }).then(data => {
      respond({ success: true, data });
    }).catch(error => {
      respond({ success: false, error: error.message });
    });
    return true;
  }

  return false;
});

/* ──────────────── extract (placeholder for now) ───────────────── */

/* ──────── attachment extraction (reference: claude-api.js + claude-normalize) ──
 *
 * Claude-hosted files are NOT downloadable from the DOM — the reference
 * exporter resolves them through the conversation JSON:
 *
 *   GET /api/organizations/{org}/chat_conversations/{id}?tree=True…
 *   → active branch via current_leaf_message_uuid + parent_message_uuid
 *   → `tool_result` items carrying `local_resource` (file_path)  →
 *       GET /api/organizations/{org}/conversations/{id}/wiggle/download-file?path=…
 *   → `image_gallery` items (remote images) → fetched best-effort (CORS)
 *
 * On top of that we keep a DOM scrape of user-row uploads as a fallback (the
 * JSON is the source of truth, but uploads render as <img>/<a> too). Every
 * descriptor carries a stable `key` so the same file is never downloaded
 * twice. Row ↔ message alignment uses the row's data-index attribute, which
 * matches the active-branch order.
 * ────────────────────────────────────────────────────────────────────────── */

interface ClaudeOrgConversationPayload {
  uuid?: string;
  chat_messages?: Array<{ uuid?: string; parent_message_uuid?: string; sender?: string; content?: unknown }>;
  current_leaf_message_uuid?: string;
}

let claudeOrgIdCache: string | null = null;

/** Discover the organization id the page itself uses for this conversation. */
async function discoverClaudeOrganizationId(conversationId: string): Promise<string> {
  if (claudeOrgIdCache) return claudeOrgIdCache;

  // 1. Same organization the page already called (resource timing entries).
  const marker = `/chat_conversations/${conversationId}`;
  const resources = performance.getEntriesByType('resource').map(entry => entry.name);
  for (let i = resources.length - 1; i >= 0; i--) {
    try {
      const url = new URL(resources[i], location.href);
      if (!url.pathname.includes(marker)) continue;
      const parts = url.pathname.split('/');
      const orgIndex = parts.indexOf('organizations');
      if (orgIndex >= 0 && parts[orgIndex + 1]) {
        claudeOrgIdCache = decodeURIComponent(parts[orgIndex + 1]);
        return claudeOrgIdCache;
      }
    } catch {
      // malformed entry — keep scanning
    }
  }

  // 2. Fall back to the account's organization list (reference behaviour).
  try {
    const response = await fetch('/api/organizations', { credentials: 'include' });
    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.organizations)
          ? (data.organizations as Array<Record<string, unknown>>)
          : [];
      const first = list[0];
      const id = String(first?.uuid || first?.id || first?.organization_id || '');
      if (id) {
        claudeOrgIdCache = id;
        return id;
      }
    }
  } catch {
    // reported by the caller as a missing-organization error
  }
  return '';
}

/** Fetch the conversation and return its active branch in chronological order. */
async function fetchClaudeBranch(
  conversationId: string,
  organizationId: string,
): Promise<Array<Record<string, unknown>>> {
  if (!organizationId) throw new Error('Claude organization id was not found');

  const query =
    '?tree=True&rendering_mode=messages&render_all_tools=true' +
    '&include_inline_comparison=true&consistency=strong';
  const response = await fetch(
    `/api/organizations/${encodeURIComponent(organizationId)}` +
    `/chat_conversations/${encodeURIComponent(conversationId)}${query}`,
    { credentials: 'include' },
  );
  if (!response.ok) throw new Error(`Claude conversation GET: ${response.status}`);
  const data = (await response.json()) as ClaudeOrgConversationPayload;

  // Reconstruct the active branch: current_leaf → parent links → root.
  const messages = Array.isArray(data.chat_messages) ? data.chat_messages : [];
  const byId = new Map(messages.map(message => [String(message.uuid ?? ''), message]));
  const ids: string[] = [];
  const seen = new Set<string>();
  let id = String(data.current_leaf_message_uuid ?? '');
  while (id && !seen.has(id)) {
    seen.add(id);
    const message = byId.get(id);
    if (!message) break;
    ids.push(id);
    const parent = String(message.parent_message_uuid ?? '');
    if (!parent || parent === '00000000-0000-4000-8000-000000000000') break;
    id = parent;
  }
  return ids.reverse().map(leafId => byId.get(leafId) as Record<string, unknown>);
}

/** Download one descriptor from any point of the Claude attachment flow. */
async function downloadClaudeDescriptor(
  descriptor: ClaudeAttachmentDescriptor,
  organizationId: string,
  conversationId: string,
): Promise<DownloadResult> {
  switch (descriptor.kind) {
    case 'local-resource': {
      if (!organizationId || !conversationId) {
        return { attachment: null, error: 'missing organization/conversation context' };
      }
      const params = new URLSearchParams({ path: descriptor.filePath });
      const url =
        `/api/organizations/${encodeURIComponent(organizationId)}` +
        `/conversations/${encodeURIComponent(conversationId)}` +
        `/wiggle/download-file?${params}`;
      return downloadAttachment(url, {
        filename: descriptor.originalName,
        mimeType: descriptor.mimeType,
      });
    }

    case 'remote-image': {
      // Third-party/image-search URLs: fetch without cookies, validate image type.
      const result = await downloadAttachment(descriptor.url, {
        filename: descriptor.originalName,
        mimeType: descriptor.mimeType,
        credentials: 'omit',
      });
      if (!result.attachment) return result;
      const mimeType = result.attachment.mimeType || '';
      if (mimeType && !mimeType.startsWith('image/')) {
        return { attachment: null, error: `non-image content: ${mimeType}` };
      }
      return result;
    }

    case 'inline-image': {
      // Inline base64 image block — no download required.
      const mimeType = descriptor.mimeType || 'image/png';
      return {
        attachment: {
          filename: finalizeAttachmentName(descriptor.originalName ?? 'image', mimeType),
          mimeType,
          dataBase64: descriptor.dataBase64,
        },
      };
    }
  }
}

/** Collect upload URLs (images + file links) inside one transcript row. */
function rowAttachmentUrls(row: HTMLElement): Array<{ url: string; filename: string | null }> {
  const out: Array<{ url: string; filename: string | null }> = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined, filename: string | null): void => {
    if (!raw) return;
    let url: string;
    try {
      url = new URL(raw, location.href).href;
    } catch {
      return;
    }
    // Accept Claude-hosted uploads (/api/uploads/…), page-local blobs from a
    // fresh paste, and claude.ai/anthropic-hosted images — while skipping
    // decorative emoji/avatar/favicon assets that also live on the host.
    const isUpload = /\/api\/uploads\//.test(url);
    const isBlob = url.startsWith('blob:');
    let isClaudeHosted = false;
    try {
      const host = new URL(url).hostname;
      isClaudeHosted = /(^|\.)claude\.ai$/.test(host) || /(^|\.)anthropic\.com$/.test(host);
    } catch {
      isClaudeHosted = false;
    }
    const isDecor = /\/(?:emoji|avatars?|favicon|logo|icons?)\//i.test(url);
    if (!isUpload && !isBlob && !isClaudeHosted) return;
    if (!isUpload && !isBlob && isDecor) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, filename });
  };

  for (const img of row.querySelectorAll('img')) {
    add(img.getAttribute('src'), (img.getAttribute('alt') || '').trim() || null);
  }
  for (const link of row.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') || '';
    if (!/\/api\/uploads\//.test(href)) continue;
    const label = (link.textContent || '').trim();
    add(href, label || null);
  }

  return out;
}

async function extractClaudeData(
  options: { includeAttachments?: boolean } = {},
): Promise<Record<string, unknown>> {
  const messageRows = rows();
  const messages: Array<{
    role: string;
    content: string;
    attachments?: ExtractedAttachment[];
  }> = [];
  const attachmentErrors: string[] = [];

  // 1. Conversation-API attachments, indexed by active-branch position. The
  //    row's data-index attribute is the branch index, so a virtualized DOM
  //    still maps rows → messages correctly.
  const conversationUuid = conversationId();
  let organizationId = '';
  let apiByIndex: ClaudeAttachmentDescriptor[][] = [];
  if (options.includeAttachments && conversationUuid) {
    try {
      organizationId = await discoverClaudeOrganizationId(conversationUuid);
      const branch = await fetchClaudeBranch(conversationUuid, organizationId);
      apiByIndex = branch.map(message => claudeMessageAttachments(message, conversationUuid));
      console.log('[KONTEKST] claude attachment diag:', JSON.stringify({
        organizationId,
        branchMessages: branch.length,
        domRows: messageRows.length,
        perMessage: apiByIndex.map(list => list.map(d => d.kind)),
      }));
    } catch (error) {
      attachmentErrors.push(`conversation API: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const { row } of messageRows) {
    const article = row.querySelector('[role="article"]');
    const textContent = article?.textContent?.trim() || '';

    // Determine user vs assistant by Claude's role markers.
    const isUser = /human|user/i.test(row.getAttribute('data-testid') || '');

    // Attachments come from the conversation JSON (files/galleries/images),
    // plus a DOM scrape of user-row uploads as fallback. Computed BEFORE the
    // text check so a file-only message still exports.
    let attachments: ExtractedAttachment[] | undefined;
    if (options.includeAttachments) {
      const downloaded: ExtractedAttachment[] = [];
      const seenKeys = new Set<string>();

      const index = Number(row.getAttribute('data-index'));
      const descriptors = Number.isInteger(index) && index >= 0 ? apiByIndex[index] ?? [] : [];
      for (const descriptor of descriptors) {
        if (seenKeys.has(descriptor.key)) continue;
        seenKeys.add(descriptor.key);
        const { attachment, error } = await downloadClaudeDescriptor(
          descriptor,
          organizationId,
          conversationUuid ?? '',
        );
        if (attachment) downloaded.push(attachment);
        else attachmentErrors.push(`${descriptor.originalName ?? descriptor.key}: ${error}`);
      }

      if (isUser) {
        for (const target of rowAttachmentUrls(row)) {
          const key = `dom:${target.url}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          const { attachment, error } = await downloadAttachment(target.url, {
            filename: target.filename,
          });
          if (attachment) downloaded.push(attachment);
          else attachmentErrors.push(`${target.filename ?? target.url}: ${error}`);
        }
      }

      if (downloaded.length) attachments = downloaded;
    }

    if (!article) continue;
    if (!textContent && !attachments) continue;

    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: article.innerHTML,
      ...(attachments ? { attachments } : {}),
    });
  }

  return {
    platform: 'claude',
    conversationId: conversationUuid,
    messages,
    extractedAt: new Date().toISOString(),
    ...(attachmentErrors.length ? { attachmentErrors } : {}),
  };
}

/* ──────────── auto-mount on first paint ══════════ */

/**
 * Mount the selection UI as soon as the page is ready.
 *
 * Unlike before, the checkboxes no longer wait for a popup toggle — this runs
 * on load, matching chatgpt.ts / grok.ts / deepseek.ts. ensureObserver() picks
 * up Claude's virtualized/streaming rows afterwards.
 */
function initClaudeSelection(): void {
  enabled = true;
  ensureObserver();
  refreshMounted();
  console.log('[KONTEKST] Claude selection UI active.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initClaudeSelection);
} else {
  initClaudeSelection();
}

console.log('[KONTEKST] Claude content script loaded — DOM selection active.');
