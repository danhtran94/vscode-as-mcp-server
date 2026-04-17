import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

import { MCPRelay, parseArgs } from './index.js';
import { initialTools } from './initial_tools.js';

// Minimal fixture HTTP server we can program per-test.
// Swapping `handler` between tests avoids nock's fetch/undici quirks entirely.
type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl: string;
let handler: Handler = (_req, _body, res) => {
  res.statusCode = 500;
  res.end('no handler configured');
};

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

// Fresh temp cache dir per relay instance so tests don't bleed into each other.
async function makeTmpCacheDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-relay-test-'));
}

function makeRelay(overrides: Partial<{
  cacheDir: string;
  maxRetries: number;
  retryIntervalMs: number;
  pollIntervalMs: number;
}> = {}, cacheDir?: string): MCPRelay {
  return new MCPRelay({
    serverUrl: baseUrl,
    cacheDir: overrides.cacheDir ?? cacheDir,
    // Fast retries — we never want a test to burn seconds on backoff.
    maxRetries: overrides.maxRetries ?? 2,
    retryIntervalMs: overrides.retryIntervalMs ?? 1,
    // Disable the background poll for unit tests.
    pollIntervalMs: overrides.pollIntervalMs ?? 0,
  });
}

describe('parseArgs', () => {
  it('returns the default server URL when no args are given', () => {
    assert.deepEqual(parseArgs([]), { serverUrl: 'http://localhost:60100' });
  });

  it('parses --server-url <value>', () => {
    assert.deepEqual(
      parseArgs(['--server-url', 'http://example.test:9000']),
      { serverUrl: 'http://example.test:9000' }
    );
  });

  it('ignores --server-url with no following value', () => {
    // Trailing flag without a value falls through to the default.
    assert.deepEqual(parseArgs(['--server-url']), { serverUrl: 'http://localhost:60100' });
  });

  it('ignores unknown flags', () => {
    assert.deepEqual(
      parseArgs(['--unknown', 'x', '--server-url', 'http://ok']),
      { serverUrl: 'http://ok' }
    );
  });
});

describe('tools cache', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await makeTmpCacheDir();
  });

  it('saveToolsCache then getToolsCache roundtrips', async () => {
    const relay = makeRelay({}, cacheDir);
    const tools = [{ name: 't1' }, { name: 't2' }];

    await relay.saveToolsCache(tools);
    const loaded = await relay.getToolsCache();

    assert.deepEqual(loaded, tools);
  });

  it('getToolsCache returns null when the cache file is missing', async () => {
    const relay = makeRelay({}, cacheDir);
    assert.equal(await relay.getToolsCache(), null);
  });

  it('getToolsCache returns null when the cache file contains invalid JSON', async () => {
    const relay = makeRelay({}, cacheDir);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(relay.toolsCacheFile, 'not-json', 'utf8');

    assert.equal(await relay.getToolsCache(), null);
  });
});

describe('requestWithRetry', () => {
  it('returns parsed JSON on 200', async () => {
    handler = (_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, n: 1 }));
    };
    const relay = makeRelay();

    const got = await relay.requestWithRetry(baseUrl, '{}');
    assert.deepEqual(got, { ok: true, n: 1 });
  });

  it('retries after a 5xx then succeeds', async () => {
    let calls = 0;
    handler = (_req, _body, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 502;
        res.end('bad gateway');
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    };
    const relay = makeRelay({ maxRetries: 3 });

    const got = await relay.requestWithRetry(baseUrl, '{}');
    assert.deepEqual(got, { ok: true });
    assert.equal(calls, 2, 'should have retried exactly once');
  });

  it('throws after exhausting retries on persistent 5xx', async () => {
    let calls = 0;
    handler = (_req, _body, res) => {
      calls++;
      res.statusCode = 503;
      res.end('down');
    };
    const relay = makeRelay({ maxRetries: 3 });

    await assert.rejects(
      () => relay.requestWithRetry(baseUrl, '{}'),
      /All retry attempts failed/
    );
    assert.equal(calls, 3);
  });

  it('throws after exhausting retries on network error', async () => {
    const relay = makeRelay({ maxRetries: 2 });
    // Port 1 is reliably refused on localhost.
    await assert.rejects(
      () => relay.requestWithRetry('http://127.0.0.1:1', '{}'),
      /All retry attempts failed/
    );
  });

  it('treats 4xx as non-retryable and surfaces the parsed body', async () => {
    handler = (_req, _body, res) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not-found' }));
    };
    const relay = makeRelay();

    const got = await relay.requestWithRetry(baseUrl, '{}');
    assert.deepEqual(got, { error: 'not-found' });
  });
});

describe('handleListTools', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await makeTmpCacheDir();
  });

  it('returns freshly fetched tools and writes cache on success', async () => {
    const freshTools = [{ name: 'fresh-1' }, { name: 'fresh-2' }];
    handler = (_req, _body, res) => {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: freshTools } }));
    };
    const relay = makeRelay({}, cacheDir);

    const result = await relay.handleListTools({ params: {} });
    assert.deepEqual(result.tools, freshTools);

    const persisted = await relay.getToolsCache();
    assert.deepEqual(persisted, freshTools);
  });

  it('falls back to the cache when the upstream fetch fails', async () => {
    const cached = [{ name: 'cached-tool' }];
    const relay = makeRelay({}, cacheDir);
    await relay.saveToolsCache(cached);

    handler = (_req, _body, res) => {
      res.statusCode = 500;
      res.end('down');
    };

    const result = await relay.handleListTools({ params: {} });
    assert.deepEqual(result.tools, cached);
  });

  it('falls back to initialTools when fetch fails and no cache exists', async () => {
    handler = (_req, _body, res) => {
      res.statusCode = 500;
      res.end('down');
    };
    const relay = makeRelay({}, cacheDir);

    const result = await relay.handleListTools({ params: {} });
    assert.deepEqual(result.tools, initialTools);
  });
});

describe('handleCallTool', () => {
  it('forwards the request method and returns the result on success', async () => {
    let seenBody: string | null = null;
    handler = (_req, body, res) => {
      seenBody = body;
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ok' }] },
      }));
    };
    const relay = makeRelay();

    const result = await relay.handleCallTool({
      method: 'tools/call',
      params: { name: 'echo', arguments: { msg: 'hi' } },
    });

    assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] });
    assert.ok(seenBody, 'request body should have been observed');
    const parsed = JSON.parse(seenBody!);
    assert.equal(parsed.method, 'tools/call');
    assert.deepEqual(parsed.params, { name: 'echo', arguments: { msg: 'hi' } });
  });

  it('returns an isError envelope when the upstream fails', async () => {
    handler = (_req, _body, res) => {
      res.statusCode = 500;
      res.end('down');
    };
    const relay = makeRelay();

    const result = await relay.handleCallTool({ method: 'tools/call', params: { name: 'x' } });

    assert.equal(result.isError, true);
    assert.ok(Array.isArray(result.content));
    const first = (result.content as Array<{ type: string; text: string }>)[0];
    assert.equal(first.type, 'text');
    assert.match(first.text, /VSCode as MCP Extension/);
  });
});
