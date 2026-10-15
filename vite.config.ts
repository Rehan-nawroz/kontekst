import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import * as path from 'path';

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  return {
    plugins: [preact()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          background: path.resolve(__dirname, 'src/background/index.ts'),
          popup: path.resolve(__dirname, 'src/popup/index.html'),
          chatgpt: path.resolve(__dirname, 'src/content-scripts/chatgpt.ts'),
          claude: path.resolve(__dirname, 'src/content-scripts/claude.ts'),
        },
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      __DEV__: isDev,
    },
  };
});
