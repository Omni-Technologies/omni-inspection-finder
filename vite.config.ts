import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works at https://<org>.github.io/<repo>/ and locally.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5230 },
  preview: { host: '127.0.0.1', port: 5231 },
});
