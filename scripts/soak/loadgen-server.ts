/**
 * scripts/soak/loadgen-server.ts — Cloud Run entrypoint.
 *
 * Cloud Run's default startup probe expects the container to accept a TCP
 * connection on $PORT. The actual load-generation work runs on independent
 * setInterval loops in loadgen.ts; this file just satisfies the platform
 * probe and exposes a tiny /status endpoint for a human to curl.
 */
import { createServer } from 'node:http';
import './loadgen.js';

const port = Number(process.env.PORT ?? '8080');

createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'loadgen_running', rig: process.env.RIG_LABEL ?? 'unknown' }));
}).listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'loadgen_server_listening', port }));
});
