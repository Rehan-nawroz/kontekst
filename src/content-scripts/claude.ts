// Content script for Claude conversations

// Listen for messages from the popup or background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'kontext:extract') {
    extractClaudeData().then(data => {
      sendResponse({ success: true, data });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Async response
  }
  return false;
});

// Extract conversation from the current Claude page
async function extractClaudeData(): Promise<Record<string, unknown>> {
  const messages: Array<{ role: string; content: string }> = [];

  // Find all message elements in the Claude UI
  const messageElements = document.querySelectorAll('[class*="message"], [class*="chat-"]');

  messageElements.forEach(element => {
    const roleElement = element.querySelector('[class*="role"]') as HTMLElement | null;
    const contentElement = element.querySelector('p, div[data-message-author-role]') as HTMLElement | null;

    if (roleElement && contentElement) {
      const role = roleElement.textContent?.trim().toLowerCase() || 'unknown';
      const authorRole = contentElement.getAttribute('data-message-author-role');
      let content = '';

      // Preserve HTML elements like code, bold, italic
      contentElement.querySelectorAll('*').forEach(child => {
        content += child.outerHTML;
      });

      messages.push({ role: authorRole || role, content });
    }
  });

  return {
    platform: 'claude',
    messages,
    pageCount: messageElements.length,
    extractedAt: new Date().toISOString(),
  };
}

console.log('Kontext content script loaded for Claude');
