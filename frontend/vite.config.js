import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config tuned to this project:
// - Output to `build/` (keeps the Go //go:embed path stable).
// - Dev server on port 3000.
// - Proxy /ws and /api during dev so the React app and the simulator can run
//   on different hosts/ports — set VITE_WS_TARGET to override the default.
//   At runtime the WS URL itself is read from VITE_WS_URL inside the app, so
//   the proxy is convenience-only.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'build',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
  },
});
