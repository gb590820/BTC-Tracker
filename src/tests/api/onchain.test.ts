/**
 * On-chain addresses API tests.
 *
 * The endpoints under test touch the chain, so the Esplora client is mocked and
 * the service is stubbed. What is really being checked here is the contract
 * around the database: ownership filtering on every route, validation of the
 * xpub before it is stored, the fact that the xpub never comes back out, and
 * that BigInt balances do not break JSON serialisation.
 */

jest.mock('../../lib/onchain/onchain-sync-service', () => {
  const actual = jest.requireActual('../../lib/onchain/onchain-sync-service');
  return {
    ...actual,
    OnchainSyncService: {
      ...actual.OnchainSyncService,
      syncWatchedAddress: jest.fn().mockResolvedValue({
        watchedAddressId: 1,
        label: 'test',
        ok: true,
        addressesScanned: 1,
        txsSeen: 0,
        txsImported: 0,
        confirmationsUpdated: 0,
        replacedMarked: 0,
        balanceSats: '0',
      }),
      syncUser: jest.fn().mockResolvedValue([]),
      syncAllUsers: jest.fn().mockResolvedValue({
        users: 0,
        addresses: 0,
        succeeded: 0,
        failed: 0,
        txsImported: 0,
        results: [],
      }),
      encryptXpubForStorage: jest.fn((xpub: string) => `enc:${xpub}`),
    },
  };
});

jest.mock('../../lib/onchain/onchain-scheduler', () => ({
  OnchainScheduler: {
    getStatus: jest.fn().mockReturnValue({ isRunning: false, intervalMinutes: 0 }),
    testConnection: jest.fn().mockResolvedValue({ reachable: true, tipHeight: 800000, endpoint: 'mock' }),
  },
}));

import { testDb, setupTestDatabase, cleanTestDatabase } from '../test-db';
import { createTestUserWithToken } from '../test-helpers';
import { NextRequest } from 'next/server';
import { GET, POST } from '../../app/api/onchain/addresses/route';
import {
  GET as getOne,
  PATCH,
  DELETE,
} from '../../app/api/onchain/addresses/[id]/route';
import { POST as syncOne } from '../../app/api/onchain/addresses/[id]/sync/route';
import { GET as status } from '../../app/api/onchain/status/route';
import { OnchainSyncService } from '@/lib/onchain/onchain-sync-service';

const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const createMockRequest = (method: string, url: string, body?: unknown, headers?: Record<string, string>) => {
  const fullUrl = url.startsWith('http') ? url : `http://localhost${url}`;
  const urlObj = new URL(fullUrl);
  return {
    method,
    url: fullUrl,
    headers: new Headers(headers || {}),
    json: async () => body || {},
    text: async () => JSON.stringify(body || {}),
    nextUrl: { pathname: urlObj.pathname, searchParams: urlObj.searchParams },
  } as unknown as NextRequest;
};

describe('On-chain addresses API', () => {
  let authHeaders: { Authorization: string };
  let userId: number;

  beforeAll(async () => {
    await setupTestDatabase();
  }, 30000);

  beforeEach(async () => {
    await cleanTestDatabase();
    const created = await createTestUserWithToken({ email: 'onchain-api@test.local' });
    authHeaders = created.authHeaders;
    userId = created.user.id;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await cleanTestDatabase();
  });

  describe('POST /api/onchain/addresses', () => {
    it('creates a watched address from a plain bc1 address', async () => {
      const res = await POST(
        createMockRequest('POST', '/api/onchain/addresses', {
          address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
          label: 'My cold wallet',
        }, authHeaders)
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
      expect(body.data.label).toBe('My cold wallet');
      expect(body.data.userId).toBe(userId);
    });

    it('rejects something that is not a Bitcoin address', async () => {
      const res = await POST(
        createMockRequest('POST', '/api/onchain/addresses', { address: 'totally-not-an-address' }, authHeaders)
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/does not look like/);
    });

    it('rejects a request with neither an address nor an xpub', async () => {
      const res = await POST(createMockRequest('POST', '/api/onchain/addresses', {}, authHeaders));
      expect(res.status).toBe(400);
    });

    it('stores an xpub encrypted and never returns it', async () => {
      const res = await POST(
        createMockRequest('POST', '/api/onchain/addresses', { xpub: ZPUB, label: 'Ledger' }, authHeaders)
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      // The derived first receive address becomes the row's primary address.
      expect(body.data.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
      expect(body.data.hasXpub).toBe(true);

      const serialised = JSON.stringify(body);
      expect(serialised).not.toContain(ZPUB);
      expect(serialised).not.toContain('xpub6');

      const row = await testDb.watchedAddress.findFirst({ where: { userId } });
      expect(row!.xpub).not.toBeNull();
      expect(row!.scriptType).toBe('p2wpkh');
    });

    it('rejects a private key with a message that says why', async () => {
      const res = await POST(
        createMockRequest(
          'POST',
          '/api/onchain/addresses',
          { xpub: 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi' },
          authHeaders
        )
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/PRIVATE key/i);
    });

    it('refuses a testnet xpub when the chain says mainnet', async () => {
      const res = await POST(
        createMockRequest(
          'POST',
          '/api/onchain/addresses',
          { xpub: 'upub5EFU65HtV5TeiSHmZZm7FUffBGy8UKeqp7vw43jYbvZPpoVsgU93oac7Wk3u6moKegAEWtGNF8DehrnHtv21XXEMYRUocHqguyjknFHYfgY' },
          authHeaders
        )
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/testnet/);
    });

    it('validates the gap limit', async () => {
      const res = await POST(
        createMockRequest('POST', '/api/onchain/addresses', { address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', gapLimit: 0 }, authHeaders)
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/gapLimit/);
    });

    it('refuses a wallet belonging to another user', async () => {
      const other = await createTestUserWithToken({ email: 'wallet-owner@test.local' });
      const foreignWallet = await testDb.wallet.create({
        data: { userId: other.user.id, name: 'Not yours', type: 'cold' },
      });

      const res = await POST(
        createMockRequest(
          'POST',
          '/api/onchain/addresses',
          { address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', walletId: foreignWallet.id },
          authHeaders
        )
      );
      expect(res.status).toBe(404);
    });

    it('refuses a duplicate address for the same chain', async () => {
      const payload = { address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' };
      const first = await POST(createMockRequest('POST', '/api/onchain/addresses', payload, authHeaders));
      expect(first.status).toBe(201);

      const second = await POST(createMockRequest('POST', '/api/onchain/addresses', payload, authHeaders));
      expect(second.status).toBe(409);
    });

    it('requires authentication', async () => {
      const res = await POST(
        createMockRequest('POST', '/api/onchain/addresses', { address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' })
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('GET /api/onchain/addresses', () => {
    it('lists only the caller addresses', async () => {
      await testDb.watchedAddress.create({
        data: { userId, address: 'bc1qmine1', label: 'Mine' },
      });
      const other = await createTestUserWithToken({ email: 'other-owner@test.local' });
      await testDb.watchedAddress.create({
        data: { userId: other.user.id, address: 'bc1qtheirs', label: 'Theirs' },
      });

      const res = await GET(createMockRequest('GET', '/api/onchain/addresses', undefined, authHeaders));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].address).toBe('bc1qmine1');
    });

    it('serialises a BigInt balance without throwing', async () => {
      // Above 21.47 BTC the 32-bit column used to reject the write entirely.
      const sats = 1500n * 100_000_000n;
      await testDb.watchedAddress.create({
        data: { userId, address: 'bc1qwhale', balanceSats: sats },
      });

      const res = await GET(createMockRequest('GET', '/api/onchain/addresses', undefined, authHeaders));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].balanceSats).toBe('150000000000');
      expect(body.data[0].balanceBtc).toBeCloseTo(1500, 6);
    });
  });

  describe('GET/PATCH/DELETE /api/onchain/addresses/[id]', () => {
    async function seed() {
      return testDb.watchedAddress.create({
        data: { userId, address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', label: 'Before' },
      });
    }

    it('reads back one address with ownership enforced', async () => {
      const row = await seed();
      const ok = await getOne(
        createMockRequest('GET', '/api/onchain/addresses/1', undefined, authHeaders),
        { params: Promise.resolve({ id: String(row.id) }) }
      );
      expect(ok.status).toBe(200);

      const other = await createTestUserWithToken({ email: 'intruder@test.local' });
      const denied = await getOne(
        createMockRequest('GET', '/api/onchain/addresses/1', undefined, other.authHeaders),
        { params: Promise.resolve({ id: String(row.id) }) }
      );
      expect(denied.status).toBe(404);
    });

    it('updates the mutable metadata', async () => {
      const row = await seed();
      const res = await PATCH(
        createMockRequest('PATCH', `/api/onchain/addresses/${row.id}`, { label: 'After', gapLimit: 30 }, authHeaders),
        { params: Promise.resolve({ id: String(row.id) }) }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.label).toBe('After');
      expect(body.data.gapLimit).toBe(30);
    });

    it('refuses to change the address, explaining why', async () => {
      const row = await seed();
      const res = await PATCH(
        createMockRequest('PATCH', `/api/onchain/addresses/${row.id}`, { address: 'bc1qsomethingelse' }, authHeaders),
        { params: Promise.resolve({ id: String(row.id) }) }
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/Create a new watched address/);
    });

    it('rejects an invalid id', async () => {
      const res = await getOne(
        createMockRequest('GET', '/api/onchain/addresses/abc', undefined, authHeaders),
        { params: Promise.resolve({ id: 'abc' }) }
      );
      expect(res.status).toBe(400);
    });

    it('keeps imported transactions when a watch is removed', async () => {
      const row = await seed();
      await testDb.bitcoinTransaction.create({
        data: {
          type: 'TRANSFER',
          btcAmount: 0.5,
          userId,
          originalCurrency: 'USD',
          transactionDate: new Date(),
          source: 'onchain',
          txid: 'ab'.repeat(32),
          watchedAddressId: row.id,
        },
      });

      const res = await DELETE(
        createMockRequest('DELETE', `/api/onchain/addresses/${row.id}`, undefined, authHeaders),
        { params: Promise.resolve({ id: String(row.id) }) }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toMatch(/1 imported transaction/);

      const kept = await testDb.bitcoinTransaction.findFirst({ where: { userId, txid: 'ab'.repeat(32) } });
      expect(kept).not.toBeNull();
      // Detached rather than cascade-deleted.
      expect(kept!.watchedAddressId).toBeNull();
    });

    it('refuses to delete another user record', async () => {
      const row = await seed();
      const other = await createTestUserWithToken({ email: 'deleter@test.local' });
      const res = await DELETE(
        createMockRequest('DELETE', `/api/onchain/addresses/${row.id}`, undefined, other.authHeaders),
        { params: Promise.resolve({ id: String(row.id) }) }
      );
      expect(res.status).toBe(404);
      expect(await testDb.watchedAddress.count({ where: { id: row.id } })).toBe(1);
    });
  });

  describe('POST /api/onchain/addresses/[id]/sync', () => {
    it('syncs an address the caller owns', async () => {
      const row = await testDb.watchedAddress.create({
        data: { userId, address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' },
      });

      const res = await syncOne(
        createMockRequest('POST', `/api/onchain/addresses/${row.id}/sync`, {}, authHeaders),
        { params: Promise.resolve({ id: String(row.id) }) }
      );
      expect(res.status).toBe(200);
      expect(OnchainSyncService.syncWatchedAddress).toHaveBeenCalled();
    });

    it('returns 502 when the backend could not be reached', async () => {
      const row = await testDb.watchedAddress.create({
        data: { userId, address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' },
      });

      (OnchainSyncService.syncWatchedAddress as jest.Mock).mockResolvedValueOnce({
        watchedAddressId: row.id,
        label: 'test',
        ok: false,
        addressesScanned: 1,
        txsSeen: 0,
        txsImported: 0,
        confirmationsUpdated: 0,
        replacedMarked: 0,
        balanceSats: '0',
        error: 'connect ECONNREFUSED',
      });

      const res = await syncOne(
        createMockRequest('POST', `/api/onchain/addresses/${row.id}/sync`, {}, authHeaders),
        { params: Promise.resolve({ id: String(row.id) }) }
      );
      expect(res.status).toBe(502);
    });

    it('does not sync another user record', async () => {
      const row = await testDb.watchedAddress.create({
        data: { userId, address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' },
      });
      const other = await createTestUserWithToken({ email: 'syncer@test.local' });

      const res = await syncOne(
        createMockRequest('POST', `/api/onchain/addresses/${row.id}/sync`, {}, other.authHeaders),
        { params: Promise.resolve({ id: String(row.id) }) }
      );
      expect(res.status).toBe(404);
      expect(OnchainSyncService.syncWatchedAddress).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/onchain/status', () => {
    it('reports the configuration and counters', async () => {
      await testDb.watchedAddress.create({ data: { userId, address: 'bc1qone' } });
      await testDb.bitcoinTransaction.create({
        data: {
          type: 'TRANSFER',
          btcAmount: 0.1,
          userId,
          originalCurrency: 'USD',
          transactionDate: new Date(),
          source: 'onchain',
          txid: 'cd'.repeat(32),
        },
      });

      const res = await status(createMockRequest('GET', '/api/onchain/status', undefined, authHeaders));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.watchedAddresses).toBe(1);
      expect(body.data.importedTransactions).toBe(1);
      expect(body.data.pendingTransactions).toBe(1);
      expect(body.data.connection).toBeUndefined();
    });

    it('probes the endpoint only when asked', async () => {
      const res = await status(
        createMockRequest('GET', '/api/onchain/status?test=1', undefined, authHeaders)
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.connection).toBeDefined();
      expect(body.connection.reachable).toBe(true);
    });
  });
});
