import { routes, type VercelConfig } from '@vercel/config/v1'

export const config: VercelConfig = {
  framework: 'vite',
  buildCommand: 'npm run build',
  outputDirectory: 'dist',
  headers: [
    // Cross-origin isolation lets ONNX Runtime run multi-threaded WebAssembly.
    routes.header('/(.*)', [
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
    ]),
    // Vite fingerprints everything under /assets, including the ONNX Runtime .wasm files.
    routes.cacheControl('/assets/(.*)', { public: true, maxAge: '1 year', immutable: true }),
    // Model files keep their names across re-exports, so revalidate them.
    routes.cacheControl('/models/(.*)', { public: true, maxAge: '1 day', staleWhileRevalidate: '1 week' }),
  ],
}
