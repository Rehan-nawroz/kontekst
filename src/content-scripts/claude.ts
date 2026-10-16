/**
 * Content script for Claude conversations — DOM selection & checkbox UI injection.
 */

// ──────────────── state ───────────────────────────────────────────────

const selectedMessageIds = new Set<string>();
const excludedMessageIds = new Set<string>();
let enabled = false;
let selectAllMode = true;
let anchorIndex: number | null = null;
let observer: ReturnType<typeof MutationObserver> | null = null;
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
  return [...document.querySelectorAll('[data-testid="transcript-row"][data-index]')]
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
  if (item.row.querySelector('__kontekst-cb')) return; // already injected.

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
    const box = item.row.querySelector('__kontekst-cb');
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
  if (msg.type === 'kontext:get-info') {
    refreshMounted();
    respond({
      title: document.title.replace(/\s*[|–-]\s*Claude.*$/i, ''),
      ...currentState(),
    } as Record<string, unknown>);
    return true;
  }

  if (msg.type === 'kontext:toggle-selection-ui') {
    enabled = !enabled;
    ensureObserver();
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontext:select-all') {
    selectAllMode = true;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    anchorIndex = null;
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontext:select-none') {
    selectAllMode = false;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    anchorIndex = null;
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontext:get-selection') {
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

  if (msg.type === 'kontext:reset-after-export') {
    selectAllMode = true;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    anchorIndex = null;
    enabled = false;
    refreshMounted();
    respond(currentState());
    return true;
  }

  if (msg.type === 'kontext:get-selection-index-ids') {
    respond(selectionIndexSnapshot());
    return true;
  }

  if (msg.type === 'kontext:enable-selection-index-watch') {
    ensureObserver();
    respond({ ok: true });
    return true;
  }

  // Existing extract handler — re-exports as needed.
  if (msg.type === 'kontext:extract') {
    extractClaudeData().then(data => {
      respond({ success: true, data });
    }).catch(error => {
      respond({ success: false, error: error.message });
    });
    return true;
  }

  return false;
});

/* ──────────────── extract (placeholder for now) ───────────────── */

async function extractClaudeData(): Promise<Record<string, unknown>> {
  const messageRows = rows();
  const messages: Array<{ role: string; content: string }> = [];

  for (const { row } of messageRows) {
    const article = row.querySelector('[role="article"]');
    if (!article) continue;
    const textContent = article.textContent?.trim() || '';
    if (!textContent) continue;

    // Determine user vs assistant by Claude's role markers.
    const isUser = /human|user/i.test(row.getAttribute('data-testid') || '').length > 0;
    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: article.innerHTML,
    });
  }

  return {
    platform: 'claude',
    conversationId: conversationId(),
    messages,
    extractedAt: new Date().toISOString(),
  };
}

console.log('[Kontext] Claude content script loaded — DOM selection active.');
