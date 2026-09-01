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
    alias: [
      { find: '@/lib/supabase', replacement: path.resolve(__dirname, 'stub-supabase.ts') },
      { find: '@/lib/workerClient', replacement: path.resolve(__dirname, 'stub-worker.ts') },
      { find: '@', replacement: path.resolve(repoRoot, 'src') },
    ],
  },
  server: { port: 5599, strictPort: true, open: false, fs: { allow: [repoRoot] } },
});
