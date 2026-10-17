export {};

/**
 * Content script for DeepSeek conversations — DOM selection & checkbox UI injection.
 *
 * Likewise the other platform scripts, this one auto-mounts selection UI on load
 * (when a DeepSeek conversation page is detected) and answers the same
 * chrome.runtime messages the popup and background already speak.
 *
 * DeepSeek extraction is still TODO.
 */

const selectedMessageIds = new Set<string>();
const excludedMessageIds = new Set<string>();
let enabled = false;
let selectAllMode = true;

function conversationId(): string | null {
  const match = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i) ||
                location.pathname.match(/\/(?:c|chat|conversation)\/([0-9a-f-]{36})(?:\/|$)/i);
  return match ? match[1] : null;
}

function rows(): Array<{ row: HTMLElement; index: number }> {
  // Placeholder — DeepSeek-specific row selector not implemented yet.
  return [];
}

function totalCount(): number {
  return rows().length;
}

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

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'kontext:get-info') {
    respond({
      title: document.title.replace(/\s*[|–-]\s*DeepSeek.*$/i, ''),
      total: totalCount(),
      selected: 0,
      enabled,
    } as Record<string, unknown>);
    return true;
  }

  if (msg.type === 'kontext:toggle-selection-ui') {
    enabled = !enabled;
    respond({ enabled, total: totalCount(), selected: 0 } as Record<string, unknown>);
    return true;
  }

  if (msg.type === 'kontext:select-all') {
    selectAllMode = true;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    respond({ enabled, total: totalCount(), selected: 0 } as Record<string, unknown>);
    return true;
  }

  if (msg.type === 'kontext:select-none') {
    selectAllMode = false;
    selectedMessageIds.clear();
    excludedMessageIds.clear();
    respond({ enabled, total: totalCount(), selected: 0 } as Record<string, unknown>);
    return true;
  }

  if (msg.type === 'kontext:extract') {
    // Not implemented yet — DeepSeek extraction is still TODO.
    respond({
      success: false,
      error: 'DeepSeek extraction is not implemented yet.',
      platform: 'deepseek',
      conversationId: conversationId(),
    } as Record<string, unknown>);
    return true;
  }

  return false;
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDeepSeekSelection);
} else {
  initDeepSeekSelection();
}

/* ──────────── auto-mount on first paint ══════════ */

function initDeepSeekSelection(): void {
  enabled = true;
  console.log('[Kontext] DeepSeek selection UI active.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDeepSeekSelection);
} else {
  initDeepSeekSelection();
}
