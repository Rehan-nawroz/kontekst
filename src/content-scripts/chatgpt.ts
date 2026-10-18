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

/** Extract all currently visible messages into a simple array for the popup/background. */
function extractChatGPTData(): Promise<Record<string, unknown>> {
  const messages: Array<{ role: string; content: string; messageId: string }> = [];
  const seenText = new Set<string>();

  const push = (role: string, content: string, messageId: string): void => {
    const normalisedRole = role.toLowerCase();
    if (normalisedRole !== 'user' && normalisedRole !== 'assistant') return;
    const text = content.trim();
    if (!text) return;
    // Same node can surface through several strategies/wrappers — keep it once.
    if (seenText.has(text)) return;
    seenText.add(text);
    messages.push({
      role: normalisedRole,
      content: text,
      messageId: messageId || `msg-${messages.length}`,
    });
  };

  // ChatGPT is a SPA that has shipped several DOM shapes over time, and some
  // builds nest the conversation in a same-origin <iframe>. Collect every
  // document we can legally read so the strategies run against all of them.
  const docs: Document[] = [document];
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    try {
      const frameDoc = frame.contentDocument;
      if (frameDoc?.body) docs.push(frameDoc);
    } catch {
      // Cross-origin frame — not readable, skip.
    }
  }

  const textOf = (el: Element | null): string => {
    if (!el) return '';
    const contentEl =
      el.querySelector<HTMLElement>('.markdown, [class*="prose"], [class*="whitespace-pre-wrap"]') ||
      (el as HTMLElement);
    return contentEl.innerText || '';
  };

  // Diagnostics — always collected so a failed export can report what the DOM
  // actually contained instead of just "no messages".
  const counts = { roleAttr: 0, turns: 0, markdown: 0, prose: 0, preWrap: 0 };
  for (const doc of docs) {
    counts.roleAttr += doc.querySelectorAll('[data-message-author-role]').length;
    counts.turns += doc.querySelectorAll('[data-testid^="conversation-turn-"]').length;
    counts.markdown += doc.querySelectorAll('.markdown').length;
    counts.prose += doc.querySelectorAll('[class*="prose"]').length;
    counts.preWrap += doc.querySelectorAll('[class*="whitespace-pre-wrap"]').length;
  }

  let strategy = 'none';

  // Strategy 1: elements that carry data-message-author-role directly — the
  // role lives on the message element, not on the conversation-turn wrapper.
  for (const doc of docs) {
    if (messages.length) break;
    const roleEls = Array.from(doc.querySelectorAll<HTMLElement>('[data-message-author-role]'));
    for (const el of roleEls) {
      push(
        el.getAttribute('data-message-author-role') || '',
        textOf(el),
        el.getAttribute('data-message-id') ||
          el.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') ||
          '',
      );
    }
    if (messages.length) strategy = 'role-attr';
  }

  // Strategy 2: conversation-turn wrappers (role sits on a descendant; if the
  // attribute is absent entirely, infer it from the content shape — assistant
  // replies render as formatted markdown, user prompts as plain text).
  if (!messages.length) {
    for (const doc of docs) {
      if (messages.length) break;
      const turns = Array.from(doc.querySelectorAll<HTMLElement>('[data-testid^="conversation-turn-"]'));
      for (const turn of turns) {
        const roleEl = turn.matches('[data-message-author-role]')
          ? turn
          : turn.querySelector<HTMLElement>('[data-message-author-role]');
        const role =
          roleEl?.getAttribute('data-message-author-role') ||
          (turn.querySelector('.markdown, [class*="prose"]') ? 'assistant' : 'user');
        push(role, textOf(turn), turn.getAttribute('data-testid') || '');
      }
      if (messages.length) strategy = 'turns';
    }
  }

  // Strategy 3: bare content blocks — neither attribute exists in this build.
  if (!messages.length) {
    for (const doc of docs) {
      for (const el of doc.querySelectorAll<HTMLElement>('.markdown, [class*="prose"]')) {
        push('assistant', el.innerText || '', '');
      }
      for (const el of doc.querySelectorAll<HTMLElement>('[class*="whitespace-pre-wrap"]')) {
        push('user', el.innerText || '', '');
      }
    }
    if (messages.length) strategy = 'content-blocks';
  }

  const diagnostics = {
    strategyUsed: strategy,
    frames: docs.length,
    iframes: document.querySelectorAll('iframe').length,
    inIframe: window !== window.top,
    href: location.href,
    counts,
    extracted: messages.length,
  };

  return Promise.resolve({
    platform: 'chatgpt',
    messages,
    pageCount: messages.length,
    extractedAt: new Date().toISOString(),
    diagnostics,
  });
}

/* ──────────── auto-mount on first paint ══════════ */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initChatGptSelection());
} else {
  initChatGptSelection();
}

console.log('[Kontext] ChatGPT content script loaded — selection UI active.');
