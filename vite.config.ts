import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Set by the Tauri CLI when it runs the dev server for a physical iPad.
const tauriDevHost = process.env.TAURI_DEV_HOST;
// Set by the Tauri CLI for both `beforeDevCommand` and `beforeBuildCommand`.
// The native app is bundled and offline anyway; a Service Worker inside
// the tauri:// origin only causes stale-asset bugs.
const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM);

function pwa(): PluginOption {
  return VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
    manifest: {
      name: 'Voltopia',
      short_name: 'Voltopia',
      description:
        'A city builder powered entirely by renewable energy — balance generation and consumption while your city grows.',
      theme_color: '#10161f',
      background_color: '#10161f',
      display: 'standalone',
      icons: [
        {
          src: 'icon.svg',
          sizes: 'any',
          type: 'image/svg+xml',
          purpose: 'any maskable',
        },
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        {
          src: 'icon-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable',
        },
      ],
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,woff2}'],
    },
  });
}

export default defineConfig({
  // For GitHub Pages the app is served from /<repo>/ — the deploy
  // workflow sets VOLTOPIA_BASE accordingly. Tauri builds leave it unset.
  base: process.env.VOLTOPIA_BASE ?? '/',
  // Keep Rust compiler errors visible when Tauri drives Vite.
  clearScreen: false,
  // Expose TAURI_ENV_* to the app (platform, arch, debug) for future use.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  plugins: [react(), ...(isTauriBuild ? [] : [pwa()])],
  server: {
    port: 5173,
    strictPort: true,
    host: tauriDevHost || false,
    hmr: tauriDevHost ? { protocol: 'ws', host: tauriDevHost, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  worker: {
    format: 'es',
  },
});
