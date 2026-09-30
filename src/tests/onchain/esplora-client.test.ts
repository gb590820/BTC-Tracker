/**
 * Esplora client tests.
 *
 * The client's contract with a backend is mostly about failure: a fresh address
 * that has never been seen must read as "no data" rather than as an error, and
 * paging must stop cleanly at the end of an address's history. Those paths are
 * `instanceof EsploraError` checks, and under the project's ES5 target a
 * subclassed Error loses its prototype, so they are covered here explicitly.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { EsploraClient, EsploraError } from '@/lib/esplora-client';

describe('EsploraClient error handling', () => {
  let server: http.Server;
  let client: EsploraClient;
  let paths: string[];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url || '/').split('?')[0];
      paths.push(path);

      if (path === '/blocks/tip/height') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('800000');
      }
      if (path.startsWith('/address/boom')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'backend exploded' }));
      }
      if (path === '/address/unknown') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      if (path === '/address/unknown/txs/mempool') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      if (path.startsWith('/address/known/txs/chain/')) {
        // A cursor the backend has never heard of.
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      if (path === '/address/known') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            address: 'known',
            chain_stats: {
              tx_count: 3,
              funded_txo_count: 3,
              funded_txo_sum: 300,
              spent_txo_count: 1,
              spent_txo_sum: 100,
            },
            mempool_stats: {
              tx_count: 0,
              funded_txo_count: 0,
              funded_txo_sum: 0,
              spent_txo_count: 0,
              spent_txo_sum: 0,
            },
          })
        );
      }
      if (path === '/address/known/txs/chain' || path === '/address/known/txs/mempool') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('[]');
      }
      if (path === '/address/known/utxo') {
        return res.end('[]');
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    client = new EsploraClient(`http://127.0.0.1:${address.port}`, 2000);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    paths = [];
  });

  it('treats a 404 as an address with no history', async () => {
    // An address the backend has never indexed is the normal case for a freshly
    // added watch, not a failure.
    await expect(client.getConfirmedTxs('unknown', 10)).resolves.toEqual([]);
  });

  it('propagates a server failure instead of hiding it as empty history', async () => {
    // The dangerous failure mode: a broken backend reported as "this address has
    // never been used", which would look like an empty wallet to the user.
    let caught: EsploraError | null = null;
    try {
      await client.getConfirmedTxs('boom', 10);
    } catch (error) {
      caught = error as EsploraError;
    }

    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(EsploraError);
    expect(caught!.status).toBe(500);
    expect(caught!.path).toContain('boom');
  });

  it('propagates a server failure from the safe variant too', async () => {
    await expect(client.getAddressInfoSafe('boom')).rejects.toBeInstanceOf(EsploraError);
  });

  it('reads an unknown address as "no data" instead of failing', async () => {
    await expect(client.getAddressInfoSafe('unknown')).resolves.toBeNull();
  });

  it('reads an empty mempool for an unknown address', async () => {
    await expect(client.getMempoolTxs('unknown')).resolves.toEqual([]);
  });

  it('stops paging when the cursor is not found', async () => {
    // Would loop on the 404 rather than stop if instanceof failed.
    await expect(client.getConfirmedTxsAfter('known', 'a'.repeat(64))).resolves.toEqual([]);
  });

  it('returns the real statistics for a known address', async () => {
    const info = await client.getAddressInfo('known');
    expect(info.chain_stats.tx_count).toBe(3);
    expect(info.chain_stats.funded_txo_sum).toBe(300);
  });

  it('reads the tip height as a number', async () => {
    await expect(client.getTipHeight()).resolves.toBe(800000);
  });
});
