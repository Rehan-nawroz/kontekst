// Content script for ChatGPT conversations

// Listen for messages from the popup or background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'kontext:extract') {
    extractChatGPTData().then(data => {
      sendResponse({ success: true, data });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Async response
  }
  return false;
});

// Extract conversation from the current ChatGPT page
async function extractChatGPTData(): Promise<Record<string, unknown>> {
  const messages: Array<{ role: string; content: string }> = [];

  // Find all message elements in the ChatGPT UI
  const messageElements = document.querySelectorAll('div[class*="message"], section[class*="message"]');

  messageElements.forEach(element => {
    const roleElement = element.querySelector('[class*="role"]') as HTMLElement | null;
    const contentElement = element.querySelector('[class*="prose"], [class*="content"]') as HTMLElement | null;

    if (roleElement && contentElement) {
      const role = roleElement.textContent?.trim().toLowerCase() || 'unknown';
      const content = contentElement.innerHTML;

      messages.push({ role, content });
    }
  });

  return {
    platform: 'chatgpt',
    messages,
    pageCount: document.querySelectorAll('div[class*="message"], section[class*="message"]').length,
    extractedAt: new Date().toISOString(),
  };
}

console.log('Kontext content script loaded for ChatGPT');
