/**
 * Batched on-chain sync tests.
 *
 * These cover the properties that only exist once several watched addresses are
 * synced together, which is how the service actually runs:
 *
 *  - a transfer between two watched wallets must not look like an outflow, and
 *    must not depend on which of the two was scanned first;
 *  - a row imported from a narrower view of the wallet must be repaired rather
 *    than left wrong;
 *  - once a cursor exists, the full history must not be downloaded again, and a
 *    backend that cannot serve the cursor must fall back to the full read instead
 *    of skipping transactions.
 *
 * The stub backend records every path it serves, so the cursor behaviour is
 * asserted on the requests actually made rather than on internals.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { prisma } from '@/lib/prisma';
import { OnchainSyncService } from '@/lib/onchain/onchain-sync-service';
import { EsploraTx } from '@/lib/esplora-client';

const SATS = 100_000_000;

function tx(partial: {
  txid: string;
  inputs?: Array<{ address: string; value: number }>;
  outputs?: Array<{ address: string; value: number }>;
  fee?: number;
  confirmed?: boolean;
  blockHeight?: number;
  blockTime?: number;
}): EsploraTx {
  const confirmed = partial.confirmed ?? true;
  return {
    txid: partial.txid,
    version: 2,
    locktime: 0,
    vin: (partial.inputs ?? []).map((input, index) => ({
      txid: `prev${index}`,
      vout: index,
      prevout: { scriptpubkey_address: input.address, value: input.value },
    })),
    vout: (partial.outputs ?? []).map((output, index) => ({
      scriptpubkey_address: output.address,
      value: output.value,
      spent: false,
    })),
    size: 200,
    weight: 800,
    fee: partial.fee ?? 0,
    status: {
      confirmed,
      ...(confirmed
        ? {
            block_height: partial.blockHeight ?? 800000,
            block_hash: 'a'.repeat(64),
            block_time: partial.blockTime ?? 1700000000,
          }
        : {}),
    },
  } as EsploraTx;
}

interface FixtureEntry {
  funded: number;
  spent: number;
  txCount: number;
  txs: EsploraTx[];
}

describe('OnchainSyncService batched sync', () => {
  let server: http.Server;
  let endpoint: string;
  let addresses: Record<string, FixtureEntry>;
  let tipHeight: number;
  let requests: string[];
  let cursorFails: boolean;

  let userId: number;
  let walletA: number;
  let walletB: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      requests.push(path);

      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      if (path === '/blocks/tip/height') {
        return send(200, String(tipHeight));
      }

      // The cursor form: /address/<addr>/txs/chain/<txid>
      const cursorMatch = /^\/address\/([^/]+)\/txs\/chain\/([^/]+)$/.exec(path);
      if (cursorMatch) {
        if (cursorFails) {
          return send(500, { error: 'cursor not supported' });
        }
        // Nothing newer than the cursor: the "already up to date" answer.
        return send(200, []);
      }

      const txsMatch = /^\/address\/([^/]+)\/txs\/(chain|mempool)$/.exec(path);
      if (txsMatch) {
        const address = decodeURIComponent(txsMatch[1]);
        const entry = addresses[address];
        if (!entry) {
          return send(404, { error: 'not found' });
        }
        const kind = txsMatch[2];
        return send(
          200,
          entry.txs.filter((t) =>
            kind === 'mempool' ? t.status.confirmed === false : t.status.confirmed === true
          )
        );
      }

      if (/^\/address\/([^/]+)\/utxo$/.test(path)) {
        return send(200, []);
      }

      const infoMatch = /^\/address\/([^/]+)$/.exec(path);
      if (infoMatch) {
        const address = decodeURIComponent(infoMatch[1]);
        const entry = addresses[address];
        if (!entry) {
          return send(404, { error: 'not found' });
        }
        return send(200, {
          address,
          chain_stats: {
            tx_count: entry.txCount,
            funded_txo_count: 1,
            funded_txo_sum: entry.funded,
            spent_txo_count: 0,
            spent_txo_sum: entry.spent,
          },
          mempool_stats: {
            tx_count: 0,
            funded_txo_count: 0,
            funded_txo_sum: 0,
            spent_txo_count: 0,
            spent_txo_sum: 0,
          },
        });
      }

      return send(404, { error: 'unknown path' });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: { email: `batch-${Date.now()}-${Math.random()}@test.local`, passwordHash: 'x'.repeat(60) },
    });
    userId = user.id;
    walletA = (
      await prisma.wallet.create({ data: { userId, name: 'Cold', type: 'cold', emoji: '🔒' } })
    ).id;
    walletB = (
      await prisma.wallet.create({ data: { userId, name: 'Hot', type: 'hot', emoji: '🔥' } })
    ).id;

    addresses = {};
    tipHeight = 800_100;
    requests = [];
    cursorFails = false;
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  function addAddress(address: string, entry: FixtureEntry) {
    addresses[address] = entry;
  }

  describe('a transfer between two watched wallets', () => {
    // 1 BTC out of the cold wallet, 0.9999 to the hot wallet, 0.0001 fee.
    const internal = tx({
      txid: 'e5'.padEnd(64, '0'),
      inputs: [{ address: 'bc1qcold', value: SATS }],
      outputs: [{ address: 'bc1qhot', value: 0.9999 * SATS }],
      fee: 0.0001 * SATS,
      blockHeight: 800_000,
    });

    beforeEach(() => {
      addAddress('bc1qcold', {
        funded: SATS,
        spent: SATS,
        txCount: 1,
        txs: [internal],
      });
      addAddress('bc1qhot', {
        funded: 0.9999 * SATS,
        spent: 0,
        txCount: 1,
        txs: [internal],
      });
    });

    it('imports only the fee, not a 1 BTC outflow', async () => {
      const cold = await prisma.watchedAddress.create({
        data: { userId, walletId: walletA, address: 'bc1qcold', label: 'cold' },
      });
      await prisma.watchedAddress.create({
        data: { userId, walletId: walletB, address: 'bc1qhot', label: 'hot' },
      });

      const results = await OnchainSyncService.syncUser(userId, endpoint);
      expect(results.every((r) => r.ok)).toBe(true);

      const rows = await prisma.bitcoinTransaction.findMany({ where: { userId } });
      expect(rows).toHaveLength(1);
      // The whole point: the net movement inside the user's own wallets is zero,
      // so the only thing that left their control is the fee.
      expect(rows[0].btcAmount).toBeCloseTo(0, 8);
      expect(rows[0].fees).toBeCloseTo(0.0001, 8);
      expect(rows[0].fromWalletId).toBe(walletA);
      expect(rows[0].toWalletId).toBe(walletB);
      // Lowest touched id, so the attribution does not depend on scan order.
      expect(rows[0].watchedAddressId).toBe(cold.id);
    });

    it('gives the same result whichever record is synced on its own', async () => {
      const cold = await prisma.watchedAddress.create({
        data: { userId, walletId: walletA, address: 'bc1qcold', label: 'cold' },
      });
      const hot = await prisma.watchedAddress.create({
        data: { userId, walletId: walletB, address: 'bc1qhot', label: 'hot' },
      });

      // Syncing only the *hot* record must still see both sides: this is the case
      // that used to import the full 1 BTC as a TRANSFER_OUT of the cold wallet
      // and then lock it in behind the unique txid index.
      const result = await OnchainSyncService.syncWatchedAddress(userId, hot.id, endpoint);
      expect(result.ok).toBe(true);

      const rows = await prisma.bitcoinTransaction.findMany({ where: { userId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].btcAmount).toBeCloseTo(0, 8);
      expect(rows[0].fees).toBeCloseTo(0.0001, 8);
      expect(rows[0].watchedAddressId).toBe(cold.id);

      // The requested record is the only one whose snapshot was written.
      const hotRow = await prisma.watchedAddress.findUnique({ where: { id: hot.id } });
      const coldRow = await prisma.watchedAddress.findUnique({ where: { id: cold.id } });
      expect(hotRow!.balanceSats).toBe(BigInt(Math.round(0.9999 * SATS)));
      expect(coldRow!.balanceSats).toBe(BigInt(0));
    });

    it('repairs a row that a narrower earlier sync got wrong', async () => {
      await prisma.watchedAddress.create({
        data: { userId, walletId: walletA, address: 'bc1qcold', label: 'cold' },
      });
      await prisma.watchedAddress.create({
        data: { userId, walletId: walletB, address: 'bc1qhot', label: 'hot' },
      });

      // What the per-record implementation would have written: the whole 1 BTC
      // leaving, fee on top.
      await prisma.bitcoinTransaction.create({
        data: {
          type: 'TRANSFER',
          btcAmount: 0.9999,
          fees: 0.0001,
          feesCurrency: 'BTC',
          userId,
          originalCurrency: 'USD',
          originalPricePerBtc: 20000,
          originalTotalAmount: 19998,
          transactionDate: new Date(1700000000000),
          transferType: 'TRANSFER_OUT',
          fromWalletId: walletA,
          source: 'onchain',
          txid: 'e5'.padEnd(64, '0'),
          blockHeight: 800_000,
          blockTime: new Date(1700000000000),
          confirmations: 101,
        },
      });

      const results = await OnchainSyncService.syncUser(userId, endpoint);
      expect(results.every((r) => r.ok)).toBe(true);

      const rows = await prisma.bitcoinTransaction.findMany({ where: { userId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].btcAmount).toBeCloseTo(0, 8);
      // The net is still slightly negative (the fee), so the direction stays
      // TRANSFER_OUT with a zero amount: the fee is what left their control.
      expect(rows[0].transferType).toBe('TRANSFER_OUT');
      expect(rows[0].fees).toBeCloseTo(0.0001, 8);
      expect(rows[0].toWalletId).toBe(walletB);
      // Revalued, because the stored cost basis was computed from a wrong amount.
      expect(rows[0].originalTotalAmount).toBe(0);
    });

    it('leaves a correct row untouched on every later sync', async () => {
      await prisma.watchedAddress.create({
        data: { userId, walletId: walletA, address: 'bc1qcold', label: 'cold' },
      });
      await prisma.watchedAddress.create({
        data: { userId, walletId: walletB, address: 'bc1qhot', label: 'hot' },
      });

      await OnchainSyncService.syncUser(userId, endpoint);
      const first = await prisma.bitcoinTransaction.findFirstOrThrow({ where: { userId } });
      const createdAt = first.createdAt;

      await OnchainSyncService.syncUser(userId, endpoint);
      const second = await prisma.bitcoinTransaction.findFirstOrThrow({ where: { userId } });

      // No rewrite, so no revaluation and no churn: the comparison has to be
      // epsilon-based, or every sync would flag its own row as drifted.
      expect(second.createdAt.getTime()).toBe(createdAt.getTime());
      expect(second.btcAmount).toBeCloseTo(0, 8);
    });
  });

  describe('incremental reads', () => {
    const incoming = tx({
      txid: 'f6'.padEnd(64, '0'),
      outputs: [{ address: 'bc1qinc', value: SATS }],
      blockHeight: 800_050,
    });

    beforeEach(() => {
      addAddress('bc1qinc', { funded: SATS, spent: 0, txCount: 1, txs: [incoming] });
    });

    it('reads the full history once, then follows the cursor', async () => {
      const record = await prisma.watchedAddress.create({
        data: { userId, walletId: walletA, address: 'bc1qinc', label: 'inc' },
      });

      await OnchainSyncService.syncUser(userId, endpoint);

      const row = await prisma.watchedAddress.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.lastSyncedTxid).toBe('f6'.padEnd(64, '0'));
      expect(row.lastSyncedAddress).toBe('bc1qinc');

      requests = [];
      await OnchainSyncService.syncUser(userId, endpoint);

      // The cursor form is now part of the request set...
      expect(requests.some((p) => p === `/address/bc1qinc/txs/chain/${'f6'.padEnd(64, '0')}`)).toBe(true);
      // ...and nothing was lost: the transaction is still there, once.
      const rows = await prisma.bitcoinTransaction.findMany({ where: { userId } });
      expect(rows).toHaveLength(1);
    });

    it('falls back to the full read when the cursor query fails', async () => {
      const record = await prisma.watchedAddress.create({
        data: { userId, walletId: walletA, address: 'bc1qinc', label: 'inc' },
      });

      await OnchainSyncService.syncUser(userId, endpoint);
      cursorFails = true;
      requests = [];

      const results = await OnchainSyncService.syncUser(userId, endpoint);
      expect(results.every((r) => r.ok)).toBe(true);

      // The cursor query was attempted, the plain history read still happened, and
      // the unusable cursor was dropped so the next sync starts clean.
      expect(requests.some((p) => p.includes('/txs/chain/'))).toBe(true);
      expect(requests.filter((p) => p === '/address/bc1qinc/txs/chain').length).toBeGreaterThan(0);

      const row = await prisma.watchedAddress.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.lastSyncError).toBeNull();

      const rows = await prisma.bitcoinTransaction.findMany({ where: { userId } });
      expect(rows).toHaveLength(1);
    });

    it('does not re-import a pending transaction once it confirms', async () => {
      const pending = tx({
        txid: 'f7'.padEnd(64, '0'),
        outputs: [{ address: 'bc1qinc', value: 0.5 * SATS }],
        confirmed: false,
      });
      addAddress('bc1qinc', { funded: 0, spent: 0, txCount: 0, txs: [pending] });

      const record = await prisma.watchedAddress.create({
        data: { userId, walletId: walletA, address: 'bc1qinc', label: 'inc' },
      });

      await OnchainSyncService.syncUser(userId, endpoint);
      let stored = await prisma.bitcoinTransaction.findFirstOrThrow({ where: { userId } });
      expect(stored.confirmations).toBe(0);
      expect(stored.blockHeight).toBeNull();

      // It gets mined, and leaves the mempool.
      addAddress('bc1qinc', {
        funded: 0.5 * SATS,
        spent: 0,
        txCount: 1,
        txs: [
          tx({
            txid: 'f7'.padEnd(64, '0'),
            outputs: [{ address: 'bc1qinc', value: 0.5 * SATS }],
            blockHeight: 800_080,
          }),
        ],
      });

      const result = await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);
      expect(result.ok).toBe(true);

      stored = await prisma.bitcoinTransaction.findFirstOrThrow({ where: { userId } });
      expect(stored.confirmations).toBe(tipHeight - 800_080 + 1);
      expect(stored.blockHeight).toBe(800_080);
      expect(stored.isReplaced).toBe(false);
    });
  });

  describe('isolation and failure handling', () => {
    it('reports a failure on every record without losing the balances', async () => {
      addAddress('bc1qbroken', { funded: SATS, spent: 0, txCount: 1, txs: [] });
      const record = await prisma.watchedAddress.create({
        data: { userId, walletId: walletA, address: 'bc1qbroken', label: 'broken', balanceSats: BigInt(7) },
      });

      // Nothing is listening on this port.
      const results = await OnchainSyncService.syncUser(userId, 'http://127.0.0.1:1', 500);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].error).toBeTruthy();

      const row = await prisma.watchedAddress.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.lastSyncError).toBeTruthy();
      // The last known balance survives a failed sync.
      expect(row.balanceSats).toBe(BigInt(7));
    });

    it('never touches another user watch list', async () => {
      addAddress('bc1qmine', { funded: SATS, spent: 0, txCount: 1, txs: [] });
      const mine = await prisma.watchedAddress.create({
        data: { userId, walletId: walletA, address: 'bc1qmine', label: 'mine' },
      });

      const other = await prisma.user.create({
        data: { email: `other-${Date.now()}@test.local`, passwordHash: 'x'.repeat(60) },
      });
      const theirs = await prisma.watchedAddress.create({
        data: { userId: other.id, address: 'bc1qmine', label: 'theirs' },
      });

      const results = await OnchainSyncService.syncUser(userId, endpoint);
      expect(results.map((r) => r.watchedAddressId)).toEqual([mine.id]);

      const otherRow = await prisma.watchedAddress.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(otherRow.lastSyncAt).toBeNull();
      expect(otherRow.lastSyncedTxid).toBeNull();

      await prisma.user.deleteMany({ where: { id: other.id } });
    });

    it('reports the address as not found instead of syncing it', async () => {
      const result = await OnchainSyncService.syncWatchedAddress(userId, 999_999, endpoint);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  });

  describe('aggregate: several outputs to the same address', () => {
    it('adds every output, not just the first', () => {
      const contexts = [{ address: 'bc1qtwice', walletId: 1, watchedAddressId: 1, isPrimary: true }];
      const result = OnchainSyncService.aggregate(
        [
          tx({
            txid: 'aa'.padEnd(64, '0'),
            outputs: [
              { address: 'bc1qtwice', value: 0.3 * SATS },
              { address: 'bc1qtwice', value: 0.2 * SATS },
            ],
          }),
        ],
        contexts
      );

      const agg = result.get('aa'.padEnd(64, '0'))!;
      expect(agg.outputsToMine).toHaveLength(2);
      expect(agg.receivedSats).toBeCloseTo(0.5 * SATS, 6);
    });
  });
});
