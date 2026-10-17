// Service worker: orchestrate extraction, ZIP archiving, and downloads
import { ZipBuilder } from '../core/ZipBuilder';
import { MarkdownRenderer } from '../renderers/Markdown';
import { HtmlRenderer } from '../renderers/Html';
import { ContentBlockType } from '../core/types';
import type { Message } from '../core/types';

// ─────────────────────────── Toolbar icon action ──────────────────────────────
//
// Decision (action-handler conflict): the toolbar icon opens the POPUP.
// manifest.json declares action.default_popup => src/popup/index.html, and Chrome
// never fires chrome.action.onClicked while a default_popup is set. The previous
// onClicked listener here was therefore unreachable code, so it has been removed
// rather than left alongside the popup.
//
// Consequence to be aware of: the popup performs injection + extraction itself and
// then sends { type: 'kontext:trigger-export' } to this service worker, but this
// worker has no chrome.runtime.onMessage listener for it yet. exportConversation
// below is therefore not yet reachable; wiring that message handler is a separate
// task and has intentionally not been done here.

// Called by the popup after it extracts the conversation from the content script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'kontext:trigger-export') return;

  // The popup already waited for kontext:extract and has the data; re-forward
  // whatever the popup passes so exportConversation stays reusable.
  const data = (message.data ?? {}) as Record<string, unknown>;
  exportConversation(data).then(
    () => sendResponse({ ok: true }),
    (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true; // async response.
});

// Export the extracted conversation data in chosen format
async function exportConversation(data: Record<string, unknown>): Promise<void> {
  const messages = (data.messages || []) as Array<{ role: string; content: string }>;

  if (messages.length === 0) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Kontext',
      message: 'No messages found in this conversation.',
    });
    return;
  }

  const zipBuilder = new ZipBuilder();

  // Add Markdown version
  // Normalise the extraction output into the shared conversation schema.
  const normalizedMessages: Message[] = messages.map((m, index) => ({
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    role: m.role === 'user' ? 'user' : 'assistant',
    sourceRole: m.role,
    createdAt: null,
    model: null,
    content: [{ type: ContentBlockType.Text, text: m.content, format: 'markdown' }],
    attachments: [],
  }));

  const mdRenderer = new MarkdownRenderer();
  const markdownContent = mdRenderer.render(normalizedMessages);
  zipBuilder.addFileSync('conversation.md', markdownContent);

  // Add HTML version
  const htmlRenderer = new HtmlRenderer();
  const htmlContent = htmlRenderer.render(normalizedMessages);
  zipBuilder.addFileSync('conversation.html', htmlContent);

  // Generate and download the ZIP file
  const blob = await zipBuilder.generate();
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url,
    filename: `kontext-export-${Date.now()}.zip`,
    saveAs: true,
  });

  // Cleanup after download starts
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Kontext',
    message: `${messages.length} messages exported successfully!`,
  });
}

console.log('Kontext background service worker loaded');
