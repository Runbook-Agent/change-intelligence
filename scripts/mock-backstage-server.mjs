import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath =
  process.env.BACKSTAGE_FIXTURE_PATH ||
  join(__dirname, '..', 'examples', 'backstage-entities.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function getItemsForFilter(filter) {
  const normalized = (filter || '').toLowerCase();
  if (normalized.includes('kind=component')) return fixture.components || [];
  if (normalized.includes('kind=resource')) return fixture.resources || [];
  return [...(fixture.components || []), ...(fixture.resources || [])];
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/api/catalog/entities/by-query') {
    const filter = url.searchParams.get('filter');
    const items = getItemsForFilter(filter);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items, pageInfo: {} }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
});

const host = process.env.BACKSTAGE_HOST || '127.0.0.1';
const port = Number(process.env.BACKSTAGE_PORT || '7007');
server.listen(port, host, () => {
  console.log(`Mock Backstage catalog listening on http://${host}:${port}`);
  console.log(`Using fixture: ${fixturePath}`);
});
