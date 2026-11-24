// Big Bundle Wright build plugin: Content Security Policy.
// GitHub Pages cannot send custom headers, so the policy is a <meta> tag in the built page.
// SPDX-License-Identifier: MPL-2.0
import type { Plugin } from 'vite';

export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Adds the CSP to production builds only (the dev server needs inline scripts for hot reload). */
export function csp(): Plugin {
  return {
    name: 'bigbundlewright-csp',
    apply: 'build',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }];
    },
  };
}
