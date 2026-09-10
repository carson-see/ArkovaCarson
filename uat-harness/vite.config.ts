// Isolated UAT harness for the SCRUM-3865 credit control. Renders
// ManageSubOrgs against stubbed supabase/worker modules so the visual UAT does
// not depend on the shared local Supabase stack (another worktree session was
// active and a concurrent `stop` would wipe the run).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    // The worktree's node_modules is a symlink, so React resolves through two
    // different real paths and Radix's primitives see a second copy — "Invalid
    // hook call" with no product defect behind it. Dedupe pins one instance.
    dedupe: ['react', 'react-dom'],
    preserveSymlinks: false,
    alias: [
      // Pin the single real React the app uses; the symlinked node_modules
      // otherwise resolves a second copy through a different real path.
      { find: /^react$/, replacement: '/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/node_modules/react' },
      { find: /^react-dom\/client$/, replacement: '/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/node_modules/react-dom/client' },
      { find: /^react-dom$/, replacement: '/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/node_modules/react-dom' },
      { find: '@/lib/supabase', replacement: path.resolve(__dirname, 'stub-supabase.ts') },
      { find: '@/lib/workerClient', replacement: path.resolve(__dirname, 'stub-worker.ts') },
      { find: '@', replacement: path.resolve(repoRoot, 'src') },
    ],
  },
  server: { port: 5599, strictPort: true, open: false, fs: { allow: [repoRoot] } },
});
