import { defineConfig } from '../../../node_modules/vite/dist/node/index.js';
import react from '../../../node_modules/@vitejs/plugin-react/dist/index.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const cliente = path.resolve(process.env.APP_CLIENTE_DIR || path.join(root, '../fabrica-app-cliente'));
const requireCliente = createRequire(path.join(cliente, 'package.json'));
const tailwind = requireCliente('@tailwindcss/postcss');
export default defineConfig({
  root: path.join(here, 'ui'),
  envFile: false,
  plugins: [{
    name: 'firebase-exclusivamente-emulado',
    enforce: 'pre',
    resolveId(id) {
      if (/(?:[\\/]lib[\\/]firebase-client|[\\/]services[\\/]firebase)(?:\.ts)?$/.test(id)) return path.join(here, 'ui/firebase.ts');
    },
    load(id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      const originals = [
        path.join(root, 'src/services/firebase.ts'),
        path.join(cliente, 'src/lib/firebase-client.ts'),
      ].map(value => value.replace(/\\/g, '/'));
      if (originals.includes(normalized)) {
        return fs.readFileSync(path.join(here, 'ui/firebase.ts'), 'utf8');
      }
    },
  }, react()],
  resolve: { dedupe: ['react', 'react-dom', 'firebase'], alias: [
    { find: /.*[\\/]lib[\\/]firebase-client(?:\.ts)?$/, replacement: path.join(here, 'ui/firebase.ts') },
    { find: /.*[\\/]services[\\/]firebase(?:\.ts)?$/, replacement: path.join(here, 'ui/firebase.ts') },
    { find: '@cliente', replacement: path.join(cliente, 'src') },
    { find: '@painel', replacement: path.join(root, 'src') },
    { find: 'next/navigation', replacement: path.join(here, 'ui/navigation.tsx') },
    { find: 'next/link', replacement: path.join(here, 'ui/link.tsx') },
    { find: 'next/image', replacement: path.join(here, 'ui/image.tsx') },
    { find: 'react', replacement: path.join(cliente, 'node_modules/react') },
    { find: 'react-dom', replacement: path.join(cliente, 'node_modules/react-dom') },
    { find: 'firebase', replacement: path.join(cliente, 'node_modules/firebase') },
    { find: 'lucide-react', replacement: path.join(cliente, 'node_modules/lucide-react') },
  ] },
  css: { postcss: { plugins: [tailwind({ base: path.join(cliente, 'src') })] } },
  server: { host: '127.0.0.1', port: 5187, strictPort: true, fs: { allow: [root, cliente] } },
});
