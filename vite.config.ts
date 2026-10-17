import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import webExtension from 'vite-plugin-web-extension';

// ─────────────────────────────────────────────────────────────────────────────
// Build notes
//
// vite-plugin-web-extension reads manifest.json and:
//   - builds every entry the manifest declares (background service worker,
//     popup HTML, content scripts), deriving the rollup inputs itself;
//   - emits stable, unhashed output filenames (e.g. src/content-scripts/grok.js)
//     so dist/manifest.json always references files that exist;
//   - bundles each script entry as a self-contained IIFE, which is what Chrome
//     requires for manifest-declared content scripts (classic scripts);
//   - rewrites the entry paths inside dist/manifest.json to the built files.
//
// Because inputs come from the manifest, there is no rollupOptions.input here.
// Adding a new content script = add it to manifest.json's content_scripts and
// create the matching src/content-scripts/<name>.ts file.
//
// NOTE: DeepSeek content script is now wired up.
//   src/content-scripts/deepseek.ts exists and manifest.json has a matching
//   content_scripts entry for https://chat.deepseek.com/*. The plugin derives
//   its build inputs from the manifest, so no change to vite.config.ts is
//   required to add DeepSeek to the build.
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';

  return {
    plugins: [
      webExtension({
        manifest: 'manifest.json',
        browser: 'chrome',
      }),
      preact(),
    ],
    build: {
      outDir: 'dist',
      // The plugin forbids the individual builds from emptying dist/ (it runs
      // several of them), so it cleans the directory itself — but only when
      // this flag is explicitly true. Without it, stale bundles from previous
      // builds would pile up in dist/.
      emptyOutDir: true,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      __DEV__: isDev,
    },
  };
});
