import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

// The webview UI is built as static assets and loaded by extension.ts via
// asWebviewUri, so Vite must run with `webview/` as its root.
export default defineConfig({
  root: path.resolve(__dirname, 'webview'),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'webview', 'dist'),
    emptyOutDir: true,
    target: 'es2020',
  },
});
