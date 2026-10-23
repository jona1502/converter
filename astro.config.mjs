// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// Rein statische Ausgabe: kein Server, keine Adapter.
export default defineConfig({
  output: 'static',
  // Shiki erzeugt Inline-Styles, die die CSP blockieren würde; Syntaxhervorhebung wird nicht gebraucht.
  markdown: { syntaxHighlight: false },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
  security: {
    // Content-Security-Policy als <meta>-Tag im Build. connect-src 'none' verhindert
    // Netzwerkaufrufe (fetch/XHR/WebSocket/Beacon) aus Seitenskripten.
    csp: {
      algorithm: 'SHA-256',
      directives: [
        "default-src 'self'",
        "connect-src 'none'",
        "img-src 'self' blob: data:",
        "worker-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ],
    },
  },
});
