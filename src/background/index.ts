// Service worker: orchestrate extraction, ZIP archiving, and downloads
import { ZipBuilder } from '../core/ZipBuilder';
import { MarkdownRenderer } from '../renderers/Markdown';
import { HtmlRenderer } from '../renderers/Html';

// Set up popup messaging for the export flow
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  // Determine which platform content script to inject
  const isChatGPT = tab.url?.startsWith('https://chatgpt.com/');
  const isClaude = tab.url?.startsWith('https://claude.ai/');

  if (!isChatGPT && !isClaude) {
    chrome.notifications.create({
      type: 'basic',
      title: 'Kontext',
      message: 'Please open a ChatGPT or Claude conversation page.',
    });
    return;
  }

  const scriptFile = isChatGPT ? '/src/content-scripts/chatgpt.ts' : '/src/content-scripts/claude.ts';

  // Inject the content script (if not already loaded) and extract data
  try {
    const [message] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [`/${scriptFile}`],
    });

    // Query for the extracted response
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'kontext:extract' });

    if (!result?.success) {
      throw new Error(result?.error || 'Extraction failed or not supported on this page.');
    }

    await exportConversation(result.data);
  } catch (error) {
    chrome.notifications.create({
      type: 'basic',
      title: 'Kontext',
      message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
});

// Export the extracted conversation data in chosen format
async function exportConversation(data: Record<string, unknown>): Promise<void> {
  const messages = (data.messages || []) as Array<{ role: string; content: string }>;

  if (messages.length === 0) {
    chrome.notifications.create({
      type: 'basic',
      title: 'Kontext',
      message: 'No messages found in this conversation.',
    });
    return;
  }

  const zipBuilder = new ZipBuilder();

  // Add Markdown version
  const mdRenderer = new MarkdownRenderer();
  const markdownContent = mdRenderer.render(
    messages.map(m => ({ id: m.role, role: m.role as any, content: m.content }))
  );
  zipBuilder.addFileSync('conversation.md', markdownContent);

  // Add HTML version
  const htmlRenderer = new HtmlRenderer();
  const htmlContent = htmlRenderer.render(
    messages.map(m => ({ id: m.role, role: m.role as any, content: m.content }))
  );
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
    title: 'Kontext',
    message: `${messages.length} messages exported successfully!`,
  });
}

console.log('Kontext background service worker loaded');
