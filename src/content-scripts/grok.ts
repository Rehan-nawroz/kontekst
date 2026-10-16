/**
 * Content script for Grok conversations — DOM selection & checkbox UI injection.
 */

// ──────────────── state ───────────────────────────────────────────────

const selectedMessageIds = new Set<string>();
const excludedMessageIds = new Set<string>();
let enabled = false;
let selectAllMode = true;
let anchorId: string | null = null;
let observer: ReturnType<typeof MutationObserver> | null = null;
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
    if (box) {
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
  });
}

// ────── data extraction for export ─────────── */

function extractGrokData(): Record<string, unknown> {
  const items = turnItems();
  const messages: Array<{ role: string; content: string }> = [];

  for (const item of items) {
    // Look for the message text element inside the response turn.
    let textEl = item.turn.querySelector('[class*="prose"], [class*="markdown"]');
    if (!textEl) {
      const article = item.turn.querySelector('[role="article"]');
      textEl = article || item.turn.querySelector('.message-text') || item.turn;
    }

    const innerHTML = (textEl?.innerHTML as string) || '';
    if (!innerHTML.trim() && !innerHTML.length) continue;

    // Determine user vs assistant from data-testid.
    const roleEl = item.turn.querySelector('[data-testid="user-message"], [data-testid="assistant-message"]');
    const hasRoleAttr = (roleEl?.getAttribute('data-testid') || '');
    const isUser = /user/i.test(hasRoleAttr);

    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: innerHTML,
    });
  }

  return {
    platform: 'grok',
    conversationId: conversationId(),
    title: document.title || '',
    messages,
    totalCount: totalMessageCount(),
    extractedAt: new Date().toLocaleString(),
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
