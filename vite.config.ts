import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Cross-origin isolation lets ONNX Runtime run multi-threaded WebAssembly.
// credentialless rather than require-corp, so Google Maps scripts and tiles (which send no CORP header) still load.
// vercel.ts sets the same headers in production.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  // ONNX Runtime resolves its .wasm files relative to import.meta.url, which pre-bundling breaks.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
})
