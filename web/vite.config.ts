import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite'
import site from './brand/site.json' with { type: 'json' }

// The backend that /api and /ws are proxied to. Override with
// BACKEND_ORIGIN when `just dev` picks a different port.
const backend = process.env.BACKEND_ORIGIN ?? 'http://localhost:8080'

const meta = (key: 'name' | 'property', value: string, content: string | number): HtmlTagDescriptor => ({
  tag: 'meta',
  attrs: { [key]: value, content: String(content) },
  injectTo: 'head',
})

const link = (attrs: Record<string, string>): HtmlTagDescriptor => ({ tag: 'link', attrs, injectTo: 'head' })

const siteHead = (): Plugin => ({
  name: 'site-head',
  transformIndexHtml: () => [
    { tag: 'title', children: site.name, injectTo: 'head' },
    meta('name', 'description', site.description),
    link({ rel: 'icon', type: 'image/svg+xml', href: site.images.favicon }),
    link({ rel: 'apple-touch-icon', href: site.images.touchIcon }),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', site.name),
    meta('property', 'og:title', site.name),
    meta('property', 'og:description', site.description),
    meta('property', 'og:image', site.images.card),
    meta('property', 'og:image:width', site.card.width),
    meta('property', 'og:image:height', site.card.height),
    meta('property', 'og:image:alt', `${site.name}: ${site.tagline}`),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:image', site.images.card),
  ],
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), siteHead()],
  build: {
    outDir: 'dist/app',
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(import.meta.dirname, './src') },
      // The speech workers run models on the GPU, and only this build of
      // ONNX Runtime carries the WebGPU backend.
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/webgpu' },
    ],
    // Load ONNX Runtime's WebAssembly itself from /ort/, which the build
    // script fills, rather than bundling a second copy of it into the app.
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  optimizeDeps: {
    // Both ship WebAssembly glued to their JavaScript, which the dependency
    // pre-bundler rewrites into something that cannot find its .wasm files.
    exclude: ['@huggingface/transformers', 'onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
      '/api': backend,
      '/speech': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
})
