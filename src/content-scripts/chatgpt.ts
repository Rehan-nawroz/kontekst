/**
 * Content script for ChatGPT conversations — DOM selection & UI injection.
 *
 * Reference: dom-selection.js (stable-id helpers, turn-root matching)
 */

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
  if (message?.type === 'kontext:extract') {
    extractChatGPTData().then(data => {
      sendResponse({ success: true, data });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // async response.
  }
  if (message?.type === 'kontext:init-selection') {
    initChatGptSelection?.();
    sendResponse({ success: true });
    return true;
  }
  if (message?.type === 'kontext:destroy-selection') {
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

/**
 * Extract the conversation via the REST API (same call the ChatGPT page makes)
 * and normalise it into the { role, content, messageId }[] shape the popup and
 * background already expect.
 */
async function extractChatGPTData(): Promise<Record<string, unknown>> {
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
  const messages: Array<{ role: string; content: string; messageId: string }> = [];
  let hiddenOrBlank = 0;
  for (const node of branch) {
    const msg = node.message;
    if (!msg || !isApiVisibleMessage(msg)) {
      hiddenOrBlank++;
      continue;
    }
    const role = msg.author?.role === 'user' ? 'user' : 'assistant';
    const content = apiTextParts(msg).join('\n\n');
    if (!content.trim()) {
      hiddenOrBlank++;
      continue;
    }
    messages.push({ role, content, messageId: msg.id || node.id });
  }

  return {
    platform: 'chatgpt',
    conversationId: data.conversation_id || null,
    title: typeof data.title === 'string' ? data.title : '',
    messages,
    pageCount: messages.length,
    extractedAt: new Date().toISOString(),
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

console.log('[Kontext] ChatGPT content script loaded — selection UI active.');
