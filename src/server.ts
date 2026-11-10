/**
 * Minimal HTTP wrapper so the rebalancer can be tested as a service.
 *
 *   GET  /health          → 200 { status: "ok" }
 *   POST /api/rebalance   → 200 RebalanceResult
 *                           400 malformed JSON
 *                           422 validation errors { errors: string[] }
 *   other methods on /api/rebalance → 405, unknown routes → 404
 */
import http from 'node:http';
import { rebalance, RebalanceRequest, ValidationError } from './rebalancer';

const PORT = Number(process.env.PORT ?? 3005);

const server = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' });
  if (req.url !== '/api/rebalance') return send(404, { error: 'Not found' });
  if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { errors: ['request body must be valid JSON'] });
    }
    try {
      return send(200, rebalance(body as RebalanceRequest));
    } catch (e) {
      if (e instanceof ValidationError) return send(422, { errors: e.errors });
      return send(500, { error: 'Internal server error' });
    }
  });
});

server.listen(PORT, () => console.log(`Rebalancer API listening on http://localhost:${PORT}`));
