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
    // npm run dev: API-Aufrufe an den lokalen Compose-Stack (nginx auf 8080, der an die Go-API weiterleitet).
    server: {
      proxy: { '/api': { target: 'http://127.0.0.1:8080' } },
    },
  },
  security: {
    // Content-Security-Policy als <meta>-Tag im Build. connect-src 'self' begrenzt
    // Netzwerkaufrufe aus Seitenskripten auf denselben Origin.
    csp: {
      algorithm: 'SHA-256',
      directives: [
        "default-src 'self'",
        "connect-src 'self'",
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
