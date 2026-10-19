export {};

/**
 * Content script for DeepSeek conversations — DOM selection & checkbox UI injection.
 *
 * Ported from the reference implementation:
 *  - DOM selection + checkbox injection  → deepseek-content.js
 *  - active-branch walk + history fetch  → deepseek-api.js
 *
 * Extraction goes through DeepSeek's own history API (the page's localStorage
 * userToken + a cookie-authenticated fetch), not a DOM scrape — the DOM for a
 * turn is a lossy rendering of the fragments (thinking / request / response),
 * so the API is the source of truth.
 */

import { downloadAttachment } from '../core/attachments';
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
let title = '';
let collecting: Promise<string[]> | null = null;

// Class selector for injected checkboxes. NB: always queried with a leading
// dot ('.kontekst-cb') — a bare 'kontekst-cb' would be a tag-name query for
// <kontekst-cb> and never match, which is what caused the duplicate-checkbox
// flood in the Claude script before it was fixed.
const CB_CLASS = 'kontekst-cb';

/* ────── conversation id + API access ─────────── */

function conversationId(): string | null {
  const match = location.pathname.match(/\/a\/chat\/s\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

/** DeepSeek stores the page's API bearer token in localStorage.userToken. */
function tokenValue(): string {
  try {
    const stored = JSON.parse(localStorage.getItem('userToken') || 'null') as
      | { value?: unknown }
      | null;
    return typeof stored?.value === 'string' ? stored.value : '';
  } catch {
    return '';
  }
}

/* ────── ordered-ids helpers (for shift-click range selection) ─────── */

/** Walk parent_id links from currentMessageId to recover the active branch. */
function buildBranch(
  chatMessages: unknown[],
  currentMessageId: unknown,
): Array<Record<string, unknown>> {
  const items = Array.isArray(chatMessages) ? chatMessages : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of items) {
    const item = raw as Record<string, unknown> | null;
    if (item?.message_id != null) byId.set(String(item.message_id), item);
  }

  const path: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let current = byId.get(String(currentMessageId ?? ''));
  while (current?.message_id != null) {
    const id = String(current.message_id);
    if (seen.has(id)) break;
    seen.add(id);
    path.push(current);
    if (current.parent_id == null) break;
    current = byId.get(String(current.parent_id));
  }
  return path.reverse();
}

/** Fetch the conversation's ordered message ids from DeepSeek's history API. */
function collectOrderedIds(): Promise<string[]> {
  if (collecting) return collecting;
  collecting = (async () => {
    const id = conversationId();
    const token = tokenValue();
    if (!id || !token) {
      orderedIds = [];
      return orderedIds;
    }

    const response = await fetch(
      `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(id)}`,
      {
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (!response.ok) throw new Error(`DeepSeek history GET: ${response.status}`);

    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      data?: {
        biz_code?: number;
        biz_msg?: string;
        biz_data?: {
          chat_session?: { current_message_id?: unknown; title?: string } | null;
          chat_messages?: unknown[];
        } | null;
      } | null;
    };
    if (payload?.code !== 0) {
      throw new Error(`DeepSeek history API: ${payload?.msg || payload?.code || 'unknown error'}`);
    }
    const envelope = payload?.data;
    if (envelope?.biz_code !== 0) {
      throw new Error(
        `DeepSeek history business API: ${envelope?.biz_msg || envelope?.biz_code || 'unknown error'}`,
      );
    }

    const biz = envelope?.biz_data;
    const session = biz?.chat_session;
    const branch = buildBranch(biz?.chat_messages ?? [], session?.current_message_id);
    orderedIds = branch
      .filter(item => /^(USER|ASSISTANT)$/i.test(String(item?.role ?? '')))
      .map(item => String(item.message_id));
    title = session?.title || title;
    refreshMounted();
    return orderedIds;
  })().finally(() => {
    collecting = null;
  });
  return collecting;
}

/* ────── DOM helpers — DeepSeek turn markers ─────────── */

/** Best-effort numeric message id from a turn node's attributes/id. */
function domMessageId(node: Element): string | null {
  const candidates: Array<unknown> = [
    node.getAttribute?.('data-virtual-list-item-key'),
    node.getAttribute?.('data-message-id'),
    node.getAttribute?.('data-msg-id'),
    String(node.id || '').match(/(?:message|msg)[-_](\d+)$/i)?.[1],
  ];
  for (const value of candidates) {
    if (value != null && /^\d+$/.test(String(value))) return String(value);
  }
  return null;
}

/** Find every visible DeepSeek turn node that the user can select. */
function turnItems(): Array<{ turn: HTMLElement; id: string }> {
  const nodes = document.querySelectorAll(
    '[data-virtual-list-item-key], [data-message-id], [data-msg-id], [id^="message-"], [id^="msg-"]',
  );
  const seen = new Set<string>();
  const out: Array<{ turn: HTMLElement; id: string }> = [];
  for (const node of nodes) {
    const id = domMessageId(node);
    if (!id || seen.has(id) || (orderedIds.length && !orderedIds.includes(id))) continue;
    seen.add(id);
    out.push({ turn: node as HTMLElement, id });
  }
  return out;
}

/* ────── selection helpers ───────────────── */

function isSelected(id: string): boolean {
  return selectAllMode ? !excludedMessageIds.has(id) : selectedMessageIds.has(id);
}

function setSelected(id: string, checked: boolean): void {
  if (selectAllMode) {
    checked ? excludedMessageIds.delete(id) : excludedMessageIds.add(id);
  } else {
    checked ? selectedMessageIds.add(id) : selectedMessageIds.delete(id);
  }
}

/* ────── checkbox injection ─────────────── */

/**
 * Inject a styled checkbox into one DeepSeek turn element.
 *
 * The duplicate check uses ':scope > .kontekst-cb' (a direct-child CLASS
 * selector). The leading dot is essential — without it the query is a tag-name
 * match for <kontekst-cb> that always misses, and every refresh would append
 * another checkbox (the Claude infinite-loop bug).
 */
function addCheckbox(item: { turn: HTMLElement; id: string }): void {
  if (item.turn.querySelector(`:scope > .${CB_CLASS}`)) return; // already injected.

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = CB_CLASS;
  box.checked = isSelected(item.id);
  box.title = 'Select message for export';
  box.setAttribute('aria-label', box.title);

  // Style: visible at top-left of the turn.
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
    pointerEvents: 'auto',
  } as Partial<CSSStyleDeclaration>);

  // Ensure the turn has a non-static positioning context.
  if (getComputedStyle(item.turn).position === 'static') {
    item.turn.style.position = 'relative';
  }
  item.turn.style.overflow = 'visible';

  box.addEventListener('click', event => {
    event.stopPropagation();
    const value = box.checked;
    if (event.shiftKey && anchorId && orderedIds.length) {
      const a = orderedIds.indexOf(anchorId);
      const b = orderedIds.indexOf(item.id);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) setSelected(orderedIds[i], value);
      } else {
        setSelected(item.id, value);
      }
    } else {
      setSelected(item.id, value);
    }
    anchorId = item.id;
    refreshMounted();
  });

  item.turn.appendChild(box);
}

function refreshMounted(): void {
  for (const item of turnItems()) {
    if (enabled) addCheckbox(item);
    const box = item.turn.querySelector(`:scope > .${CB_CLASS}`);
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

/* ────── MutationObserver — virtualized/streaming UI ──── */

function ensureObserver(): void {
  if (observer || !document.body) return;
  observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-virtual-list-item-key', 'data-message-id', 'data-msg-id', 'id'],
  });
}

/* ────── query handlers (popup ↔ content) ─────────── */

function currentState(): Record<string, unknown> {
  const total = orderedIds.length;
  const selected = selectAllMode
    ? Math.max(0, total - [...excludedMessageIds].filter(id => orderedIds.includes(id)).length)
    : [...selectedMessageIds].filter(id => orderedIds.includes(id)).length;
  return { total, selected, enabled, title: title || document.title };
}

function selectionSnapshot(): Record<string, unknown> {
  return {
    conversationId: conversationId(),
    selectAll: selectAllMode,
    selectedMessageIds: [...selectedMessageIds],
    excludedMessageIds: [...excludedMessageIds],
    orderedIds: [...orderedIds],
    temporaryIds: [] as string[],
  };
}

/* ────── extraction (via DeepSeek history API) ─────────── */

/** Render one API turn's fragments into a single markdown-ish content string. */
function turnContent(turn: Record<string, unknown>): string {
  const fragments = Array.isArray(turn.fragments) ? turn.fragments : [];
  const parts: string[] = [];
  for (const raw of fragments) {
    const fragment = raw as Record<string, unknown> | null;
    const type = String(fragment?.type ?? '').toUpperCase();
    if (type !== 'REQUEST' && type !== 'RESPONSE' && type !== 'THINK') continue;
    const content = typeof fragment?.content === 'string' ? fragment.content : '';
    if (!content.trim()) continue;
    if (type === 'THINK') {
      const elapsed = Number(fragment?.elapsed_secs);
      const suffix = Number.isFinite(elapsed)
        ? ` (${elapsed.toFixed(1).replace(/\.0$/, '')} s)`
        : '';
      parts.push(`#### Thinking${suffix}\n\n${content}`);
    } else {
      parts.push(content);
    }
  }
  return parts.join('\n\n');
}

/* ──────── attachment extraction (FILE fragments → signed_path) ─────────────
 *
 * User uploads arrive in the history payload as fragments carrying a
 * `files: [{ id, file_name, signed_path, is_image }]` array. The signed_path
 * is a site-relative download URL that already embeds an auth signature; the
 * Bearer token is attached as well for safety.
 * ────────────────────────────────────────────────────────────────────────── */

interface DeepSeekFragmentFile {
  id?: string | number | null;
  file_name?: string | null;
  signed_path?: string | null;
  is_image?: boolean;
}

/** Collect downloadable file descriptors from one raw message's fragments. */
function fragmentFiles(
  turn: Record<string, unknown>,
): Array<{ url: string; filename: string | null }> {
  const out: Array<{ url: string; filename: string | null }> = [];
  const seen = new Set<string>();
  const fragments = Array.isArray(turn.fragments) ? turn.fragments : [];
  for (const raw of fragments) {
    const fragment = raw as { files?: DeepSeekFragmentFile[] } | null;
    if (!fragment || !Array.isArray(fragment.files)) continue;
    for (const file of fragment.files) {
      if (!file?.signed_path) continue;
      let url: string;
      try {
        url = new URL(file.signed_path, location.origin).href;
      } catch {
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, filename: file.file_name || null });
    }
  }
  return out;
}

async function extractDeepSeekData(
  options: { includeAttachments?: boolean } = {},
): Promise<Record<string, unknown>> {
  const id = conversationId();
  if (!id) throw new Error('No active DeepSeek conversation (open a /a/chat/s/<id> page).');
  const token = tokenValue();
  if (!token) throw new Error('DeepSeek user token is missing from localStorage.');

  const response = await fetch(
    `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(id)}`,
    {
      credentials: 'include',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok) throw new Error(`DeepSeek history GET: ${response.status}`);

  const payload = (await response.json()) as {
    code?: number;
    msg?: string;
    data?: {
      biz_code?: number;
      biz_msg?: string;
      biz_data?: {
        chat_session?: { current_message_id?: unknown; title?: string } | null;
        chat_messages?: unknown[];
      } | null;
    } | null;
  };
  if (payload?.code !== 0) {
    throw new Error(`DeepSeek history API: ${payload?.msg || payload?.code || 'unknown error'}`);
  }
  const envelope = payload?.data;
  if (envelope?.biz_code !== 0) {
    throw new Error(
      `DeepSeek history business API: ${envelope?.biz_msg || envelope?.biz_code || 'unknown error'}`,
    );
  }

  const biz = envelope?.biz_data;
  const session = biz?.chat_session;
  if (!session || session.current_message_id == null) {
    throw new Error('No active DeepSeek conversation.');
  }

  const branch = buildBranch(biz?.chat_messages ?? [], session.current_message_id);
  const messages: Array<{
    role: string;
    content: string;
    messageId: string;
    attachments?: ExtractedAttachment[];
  }> = [];
  const attachmentErrors: string[] = [];
  for (const turn of branch) {
    const rawRole = String(turn.role ?? '').toUpperCase();
    if (rawRole !== 'USER' && rawRole !== 'ASSISTANT') continue;
    const role = rawRole === 'USER' ? 'user' : 'assistant';
    const messageId = String(turn.message_id);

    // Honour an active manual selection: skip deselected messages. When no
    // selection UI has been used, include the whole branch.
    if (!selectAllMode && !selectedMessageIds.has(messageId)) continue;
    if (selectAllMode && excludedMessageIds.has(messageId)) continue;

    const content = turnContent(turn);

    // User uploads live on the message itself, so a turn with files but no
    // text still exports its attachments.
    let attachments: ExtractedAttachment[] | undefined;
    if (options.includeAttachments && role === 'user') {
      const targets = fragmentFiles(turn);
      if (targets.length) {
        attachments = [];
        for (const target of targets) {
          const { attachment, error } = await downloadAttachment(target.url, {
            filename: target.filename,
            headers: { Authorization: `Bearer ${token}` },
          });
          if (attachment) attachments.push(attachment);
          else attachmentErrors.push(`${target.filename ?? target.url}: ${error}`);
        }
        if (!attachments.length) attachments = undefined;
      }
    }

    if (!content.trim() && !attachments) continue;
    messages.push({ role, content, messageId, ...(attachments ? { attachments } : {}) });
  }

  return {
    platform: 'deepseek',
    conversationId: id,
    title: session.title || document.title.replace(/\s*[|–-]\s*DeepSeek.*$/i, ''),
    messages,
    extractedAt: new Date().toISOString(),
    ...(attachmentErrors.length ? { attachmentErrors } : {}),
  };
}

/* ────── message listener ─────────── */

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'kontext:get-info') {
    collectOrderedIds()
      .then(() => respond({ ...currentState() }))
      .catch(() => respond({ ...currentState() }));
    return true;
  }

  if (msg.type === 'kontext:toggle-selection-ui') {
    enabled = !enabled;
    ensureObserver();
    collectOrderedIds()
      .catch(() => [] as string[])
      .then(() => {
        refreshMounted();
        respond(currentState());
      });
    return true;
  }

  if (msg.type === 'kontext:select-all') {
    selectAllMode = true;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    anchorId = null;
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontext:select-none') {
    selectAllMode = false;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    anchorId = null;
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontext:get-selection') {
    collectOrderedIds()
      .then(() => respond(selectionSnapshot()))
      .catch(() => respond(selectionSnapshot()));
    return true;
  }

  if (msg.type === 'kontext:reset-after-export') {
    selectAllMode = true;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    anchorId = null;
    enabled = false;
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontext:get-selection-index-ids') {
    collectOrderedIds()
      .then(() => respond({ conversationId: conversationId(), ids: [...orderedIds], temporaryIds: [] }))
      .catch(() => respond({ conversationId: conversationId(), ids: [], temporaryIds: [] }));
    return true;
  }

  if (msg.type === 'kontext:enable-selection-index-watch') {
    ensureObserver();
    respond({ ok: true });
    return true;
  }

  if (msg.type === 'kontext:extract') {
    extractDeepSeekData({ includeAttachments: !!msg.includeAttachments }).then(data => {
      respond({ success: true, data });
    }).catch(error => {
      respond({ success: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  return false;
});

/* ──────────── auto-mount on first paint ══════════ */

function initDeepSeekSelection(): void {
  enabled = true;
  ensureObserver();
  collectOrderedIds()
    .catch(() => [] as string[])
    .then(() => refreshMounted());
  console.log('[Kontext] DeepSeek selection UI active.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDeepSeekSelection);
} else {
  initDeepSeekSelection();
}

console.log('[Kontext] DeepSeek content script loaded.');
