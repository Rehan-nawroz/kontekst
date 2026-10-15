# kontekst

A browser extension for exporting and contextualizing AI chat conversations across multiple platforms.

## Features

- Export conversations from ChatGPT, Claude, Grok, and DeepSeek
- Support for Markdown and HTML output formats
- Platform-specific content extraction and normalization
- Modular architecture with separate extractors per platform
- Preact-based popup UI for configuration and control

## Project Structure

```
kontekst/
├── manifest.json              # Browser extension manifest
├── package.json               # Dependencies and scripts
├── vite.config.ts             # Build configuration
├── README.md                  # This file
├── LICENSE
└── src/
    ├── background/            # Service worker logic
    ├── popup/                 # Extension popup UI (Preact)
    ├── core/                  # Shared utilities and types
    ├── platforms/             # Platform-specific extractors
    ├── renderers/             # Markdown and HTML renderers
    └── content-scripts/       # Browser content scripts
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Production Build

```bash
npm run build
```

### Loading in Browser

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable Developer mode
3. Click "Load unpacked" and select the `/dist` directory

## License

MIT
