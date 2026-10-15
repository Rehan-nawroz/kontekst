import { createElement, FormEvent, useCallback, useState } from 'preact';

interface MessageData {
  success: boolean;
  data?: Record<string, unknown>;
}

const PLATFORMS = [
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'claude', label: 'Claude' },
] as const;

export function App() {
  const [selectedPlatform, setSelectedPlatform] = useState<string>('chatgpt');
  const [status, setStatus] = useState<string>('Ready');
  const [isExporting, setIsExporting] = useState<boolean>(false);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setStatus('Initializing...');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id) throw new Error('No active tab found.');

      const isValidPage = tab.url?.startsWith(
        selectedPlatform === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/'
      );

      if (!isValidPage) {
        throw new Error(`Please open a ${selectedPlatform} conversation page.`);
      }

      setStatus('Extracting...');

      const [script] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          selectedPlatform === 'chatgpt'
            ? '/src/content-scripts/chatgpt.ts'
            : '/src/content-scripts/claude.ts',
        ],
      });

      const result = await chrome.tabs.sendMessage<MessageData>(tab.id, {
        type: 'kontext:extract',
      });

      if (!result?.success) throw new Error('Extraction failed.');

      setStatus('Exporting...');

      // Trigger the background script to handle export
      await chrome.runtime.sendMessage({ type: 'kontext:trigger-export' });

      setStatus(`Exported ${selectedPlatform} conversation!`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'An error occurred.');
    } finally {
      setIsExporting(false);
    }
  }, [selectedPlatform]);

  return (
    <div class="kontext-app">
      <header class="app-header">
        <h1>Kontext</h1>
        <p>AI Chat Exporter</p>
      </header>

      <main class="app-content">
        <div class="field-group">
          <label for="platform">Platform</label>
          <select
            id="platform"
            value={selectedPlatform}
            onChange={(e) => setSelectedPlatform(e.currentTarget.value)}
            disabled={isExporting}
          >
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <button class="export-btn" onClick={handleExport} disabled={isExporting}>
          {isExporting ? 'Exporting...' : 'Export Conversation'}
        </button>

        <p class={`status status-${isExporting ? 'loading' : 'idle'}`}>{status}</p>
      </main>
    </div>
  );
}
