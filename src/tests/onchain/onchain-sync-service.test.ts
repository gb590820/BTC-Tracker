/**
 * OnchainSyncService tests.
 *
 * The riskiest part of the feature is not the HTTP call, it is the arithmetic:
 * a transaction touching several watched addresses must be counted once, a
 * change-address spend must not look like an outflow, and a fee must be removed
 * exactly once. A mistake there silently corrupts the user's portfolio, so the
 * aggregation and classification are tested as pure functions with hand-computed
 * satoshi values.
 *
 * The database-backed cases use a stub esplora backend served from the test
 * process, which keeps the whole path — HTTP included — deterministic.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { prisma } from '@/lib/prisma';
import { OnchainSyncService } from '@/lib/onchain/onchain-sync-service';
import { EsploraTx } from '@/lib/esplora-client';
import { parseXpub } from '@/lib/onchain/address-derivation';
import { EncryptionService } from '@/lib/encryption-service';

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
      txid: `${partial.txid.slice(0, 8)}in${index}`,
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

describe('OnchainSyncService.aggregate', () => {
  const contexts = [
    { address: 'bc1qmine0', walletId: 1, watchedAddressId: 10, isPrimary: true },
    { address: 'bc1qmine1', walletId: 1, watchedAddressId: 10, isPrimary: false },
    { address: 'bc1qother', walletId: 2, watchedAddressId: 20, isPrimary: true },
  ];

  it('ignores transactions that touch none of the watched addresses', () => {
    const result = OnchainSyncService.aggregate(
      [tx({ txid: 'a'.repeat(64), inputs: [{ address: 'bc1qtheirs', value: SATS }] })],
      contexts
    );
    expect(result.size).toBe(0);
  });

  it('counts a pure incoming transaction once', () => {
    const result = OnchainSyncService.aggregate(
      [tx({ txid: 'b'.repeat(64), outputs: [{ address: 'bc1qmine0', value: 0.5 * SATS }] })],
      contexts
    );
    expect(result.size).toBe(1);
    const agg = result.get('b'.repeat(64))!;
    expect(agg.receivedSats).toBe(0.5 * SATS);
    expect(agg.spentSats).toBe(0);
    expect(agg.fromWalletId).toBeNull();
    expect(agg.toWalletId).toBe(1);
  });

  it('deduplicates a transaction seen through two of the watched addresses', () => {
    // The same txid returned once per address, which is exactly what esplora
    // does when a spend pays one of our addresses and the change lands on
    // another one.
    const same = tx({
      txid: 'c'.repeat(64),
      inputs: [{ address: 'bc1qmine0', value: 1 * SATS }],
      outputs: [{ address: 'bc1qmine1', value: 0.9 * SATS }],
      fee: 0.01 * SATS,
    });
    const result = OnchainSyncService.aggregate([same, same, same], contexts);

    expect(result.size).toBe(1);
    const agg = result.get('c'.repeat(64))!;
    expect(agg.spentSats).toBe(1 * SATS);
    expect(agg.receivedSats).toBe(0.9 * SATS);
    // Not tripled, which is the whole point of the fold.
    expect(agg.spentSats).toBeLessThan(1.1 * SATS);
  });

  it('attributes a transaction between two of the user wallets to both wallets', () => {
    const result = OnchainSyncService.aggregate(
      [
        tx({
          txid: 'd'.repeat(64),
          inputs: [{ address: 'bc1qmine0', value: 1 * SATS }],
          outputs: [{ address: 'bc1qother', value: 0.99 * SATS }],
          fee: 0.01 * SATS,
        }),
      ],
      contexts
    );
    const agg = result.get('d'.repeat(64))!;
    expect(agg.fromWalletId).toBe(1);
    expect(agg.toWalletId).toBe(2);
    expect(agg.touched.has(10)).toBe(true);
    expect(agg.touched.has(20)).toBe(true);
  });

  it('leaves the wallet null when several wallets fund the same transaction', () => {
    const result = OnchainSyncService.aggregate(
      [
        tx({
          txid: 'e'.repeat(64),
          inputs: [
            { address: 'bc1qmine0', value: 60_000_000 },
            { address: 'bc1qother', value: 50_000_000 },
          ],
          outputs: [{ address: 'bc1qtheirs', value: 109_000_000 }],
          fee: 1_000_000,
        }),
      ],
      contexts
    );
    const agg = result.get('e'.repeat(64))!;
    expect(agg.fromWalletId).toBeNull();
    expect(agg.spentSats).toBe(110_000_000);
  });

  it('treats a missing fee as zero rather than NaN', () => {
    const result = OnchainSyncService.aggregate(
      [tx({ txid: 'f'.repeat(64), inputs: [{ address: 'bc1qmine0', value: 1 * SATS }], fee: NaN })],
      contexts
    );
    expect(result.get('f'.repeat(64))!.feeSats).toBe(0);
  });
});

describe('OnchainSyncService.classify', () => {
  const ctx = { address: 'bc1qmine', walletId: 1, watchedAddressId: 1, isPrimary: true };

  function classifyOne(t: EsploraTx) {
    const agg = OnchainSyncService.aggregate([t], [ctx]).get(t.txid)!;
    return OnchainSyncService.classify(agg);
  }

  it('records an incoming transfer with no fee', () => {
    const result = classifyOne(
      tx({ txid: '1'.repeat(64), outputs: [{ address: 'bc1qmine', value: 0.25 * SATS }] })
    );
    expect(result.type).toBe('TRANSFER_IN');
    expect(result.transferType).toBe('TRANSFER_IN');
    expect(result.btcAmount).toBeCloseTo(0.25, 8);
    expect(result.fees).toBe(0);
  });

  it('subtracts the fee exactly once on an outgoing transfer', () => {
    // 1 BTC leaves, 0.01 BTC of it is the fee, so 0.99 BTC is the amount that
    // actually left the user's control and the fee is tracked separately.
    const result = classifyOne(
      tx({
        txid: '2'.repeat(64),
        inputs: [{ address: 'bc1qmine', value: 1 * SATS }],
        outputs: [{ address: 'bc1qtheirs', value: 0.99 * SATS }],
        fee: 0.01 * SATS,
      })
    );
    expect(result.type).toBe('TRANSFER_OUT');
    expect(result.btcAmount).toBeCloseTo(0.99, 8);
    expect(result.fees).toBeCloseTo(0.01, 8);
    // btcAmount + fees must reconstruct the full value that left, otherwise
    // BitcoinPriceService would subtract the wrong total from the portfolio.
    expect(result.btcAmount + result.fees).toBeCloseTo(1, 8);
  });

  it('collapses a change-address spend to zero, not an outflow', () => {
    // The change address has to be watched too, otherwise the service has no way
    // of knowing the money came back — which is the entire reason an xpub is
    // required in the first place.
    const withChange = [
      ctx,
      { address: 'bc1qminechange', walletId: 1, watchedAddressId: 1, isPrimary: false },
    ];
    const spend = tx({
      txid: '3'.repeat(64),
      inputs: [{ address: 'bc1qmine', value: 100_000_000 }],
      outputs: [{ address: 'bc1qminechange', value: 99_000_000 }],
      fee: 1_000_000,
    });
    const agg = OnchainSyncService.aggregate([spend], withChange).get(spend.txid)!;
    const result = OnchainSyncService.classify(agg);

    expect(agg.receivedSats).toBe(99_000_000);
    expect(result.btcAmount).toBe(0);
    expect(result.fees).toBeCloseTo(0.01, 8);
  });

  it('treats the same spend as a real outflow when the change address is not watched', () => {
    // The failure mode the xpub is meant to prevent: without the change address
    // in the set, a self-spend looks like a 1 BTC outflow.
    const spend = tx({
      txid: '9'.repeat(64),
      inputs: [{ address: 'bc1qmine', value: 100_000_000 }],
      outputs: [{ address: 'bc1qunwatchedchange', value: 99_000_000 }],
      fee: 1_000_000,
    });
    const result = classifyOne(spend);
    expect(result.btcAmount).toBeCloseTo(0.99, 8);
  });

  it('never reports a negative amount', () => {
    const result = classifyOne(
      tx({
        txid: '4'.repeat(64),
        inputs: [{ address: 'bc1qmine', value: 1 * SATS }],
        outputs: [],
        fee: 0,
      })
    );
    expect(result.btcAmount).toBeGreaterThanOrEqual(0);
    expect(result.fees).toBeGreaterThanOrEqual(0);
  });

  it('keeps a large balance exact to the satoshi', () => {
    const result = classifyOne(
      tx({ txid: '5'.repeat(64), outputs: [{ address: 'bc1qmine', value: 123_456_789 }] })
    );
    expect(result.btcAmount).toBeCloseTo(1.23456789, 8);
  });
});

/**
 * A minimal esplora stand-in. Only the four endpoints the service uses are
 * implemented, driven by a per-address fixture so each test can describe the
 * chain state it needs.
 */
interface Fixture {
  tipHeight: number;
  addresses: Record<string, { balance: number; funded: number; spent: number; txCount: number; txs: EsploraTx[] }>;
}

describe('OnchainSyncService.syncWatchedAddress (against a stub backend)', () => {
  let server: http.Server;
  let endpoint: string;
  let fixture: Fixture;
  let userId: number;
  let walletId: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      if (path === '/blocks/tip/height') {
        return send(200, String(fixture.tipHeight));
      }

      const txsMatch = /^\/address\/([^/]+)\/txs\/(chain|mempool)$/.exec(path);
      if (txsMatch) {
        const address = decodeURIComponent(txsMatch[1]);
        const entry = fixture.addresses[address];
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

      const utxoMatch = /^\/address\/([^/]+)\/utxo$/.exec(path);
      if (utxoMatch) {
        const address = decodeURIComponent(utxoMatch[1]);
        return send(200, fixture.addresses[address] ? [] : []);
      }

      const infoMatch = /^\/address\/([^/]+)$/.exec(path);
      if (infoMatch) {
        const address = decodeURIComponent(infoMatch[1]);
        const entry = fixture.addresses[address];
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
      data: { email: `onchain-${Date.now()}-${Math.random()}@test.local`, passwordHash: 'x'.repeat(60) },
    });
    userId = user.id;
    const wallet = await prisma.wallet.create({
      data: { userId, name: 'Cold', type: 'cold', emoji: '🔒' },
    });
    walletId = wallet.id;
    fixture = { tipHeight: 800_100, addresses: {} };
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function watchAddress(address: string) {
    return prisma.watchedAddress.create({
      data: { userId, walletId, address, label: 'test' },
    });
  }

  it('imports a confirmed incoming transaction and stores the balance snapshot', async () => {
    fixture.addresses['bc1qin'] = {
      balance: 0,
      funded: 2 * SATS,
      spent: 0,
      txCount: 1,
      txs: [
        tx({
          txid: 'a1'.padEnd(64, '0'),
          outputs: [{ address: 'bc1qin', value: 2 * SATS }],
          blockHeight: 800_000,
          blockTime: Date.UTC(2023, 10, 14) / 1000,
        }),
      ],
    };

    const record = await watchAddress('bc1qin');
    const result = await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);

    expect(result.ok).toBe(true);
    expect(result.txsImported).toBe(1);

    const stored = await prisma.bitcoinTransaction.findFirst({
      where: { userId, txid: 'a1'.padEnd(64, '0') },
    });
    expect(stored).not.toBeNull();
    expect(stored!.type).toBe('TRANSFER');
    expect(stored!.source).toBe('onchain');
    expect(stored!.transferType).toBe('TRANSFER_IN');
    expect(stored!.btcAmount).toBeCloseTo(2, 8);
    expect(stored!.confirmations).toBe(800_100 - 800_000 + 1);
    expect(stored!.toWalletId).toBe(walletId);
    expect(stored!.watchedAddressId).toBe(record.id);

    const row = await prisma.watchedAddress.findUnique({ where: { id: record.id } });
    expect(row!.balanceSats).toBe(BigInt(2 * SATS));
    expect(row!.lastSyncError).toBeNull();
    expect(row!.lastSyncBlock).toBe(800_100);
  });

  it('repairs wallet attribution when an existing watch is later attached', async () => {
    fixture.addresses['bc1qattached'] = {
      balance: 0,
      funded: SATS,
      spent: 0,
      txCount: 1,
      txs: [
        tx({
          txid: 'attached'.padEnd(64, '0'),
          outputs: [{ address: 'bc1qattached', value: SATS }],
        }),
      ],
    };

    const record = await prisma.watchedAddress.create({
      data: { userId, walletId: null, address: 'bc1qattached', label: 'test' },
    });
    await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);

    await prisma.watchedAddress.update({
      where: { id: record.id },
      data: { walletId },
    });
    await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);

    const stored = await prisma.bitcoinTransaction.findFirst({
      where: { userId, txid: 'attached'.padEnd(64, '0') },
    });
    expect(stored!.toWalletId).toBe(walletId);
    expect(stored!.watchedAddressId).toBe(record.id);
  });

  it('does not import the same txid twice on a second sync', async () => {
    fixture.addresses['bc1qdup'] = {
      balance: 0,
      funded: SATS,
      spent: 0,
      txCount: 1,
      txs: [tx({ txid: 'b1'.padEnd(64, '0'), outputs: [{ address: 'bc1qdup', value: SATS }] })],
    };

    const record = await watchAddress('bc1qdup');
    const first = await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);
    const second = await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);

    expect(first.txsImported).toBe(1);
    expect(second.txsImported).toBe(0);
    expect(await prisma.bitcoinTransaction.count({ where: { userId, txid: 'b1'.padEnd(64, '0') } })).toBe(1);
  });

  it('promotes a pending transaction to confirmed instead of duplicating it', async () => {
    const pendingTxid = 'c1'.padEnd(64, '0');
    fixture.addresses['bc1qrbf'] = {
      balance: 0,
      funded: SATS,
      spent: 0,
      txCount: 1,
      txs: [
        tx({
          txid: pendingTxid,
          outputs: [{ address: 'bc1qrbf', value: SATS }],
          confirmed: false,
        }),
      ],
    };

    const record = await watchAddress('bc1qrbf');
    await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);

    let stored = await prisma.bitcoinTransaction.findFirst({ where: { userId, txid: pendingTxid } });
    expect(stored!.confirmations).toBe(0);
    expect(stored!.blockHeight).toBeNull();

    // It gets mined on the next poll.
    fixture.addresses['bc1qrbf'].txs = [
      tx({
        txid: pendingTxid,
        outputs: [{ address: 'bc1qrbf', value: SATS }],
        blockHeight: 800_090,
      }),
    ];

    const second = await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);
    expect(second.txsImported).toBe(0);
    expect(second.confirmationsUpdated).toBe(1);

    stored = await prisma.bitcoinTransaction.findFirst({ where: { userId, txid: pendingTxid } });
    expect(stored!.confirmations).toBe(800_100 - 800_090 + 1);
    expect(stored!.blockHeight).toBe(800_090);
    expect(await prisma.bitcoinTransaction.count({ where: { userId, txid: pendingTxid } })).toBe(1);
  });

  it('marks a transaction that vanished from the mempool as replaced', async () => {
    const droppedTxid = 'd1'.padEnd(64, '0');
    fixture.addresses['bc1qdrop'] = {
      balance: 0,
      funded: SATS,
      spent: 0,
      txCount: 1,
      txs: [
        tx({ txid: droppedTxid, outputs: [{ address: 'bc1qdrop', value: SATS }], confirmed: false }),
      ],
    };

    const record = await watchAddress('bc1qdrop');
    await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);

    // The replacement paid a higher fee, so the original is gone.
    fixture.addresses['bc1qdrop'].txs = [];
    const second = await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);

    expect(second.replacedMarked).toBe(1);
    const stored = await prisma.bitcoinTransaction.findFirst({ where: { userId, txid: droppedTxid } });
    expect(stored!.isReplaced).toBe(true);
  });

  it('records the failure on the row and does not throw when the endpoint is down', async () => {
    const record = await watchAddress('bc1qunreachable');
    const result = await OnchainSyncService.syncWatchedAddress(
      userId,
      record.id,
      'http://127.0.0.1:1'
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const row = await prisma.watchedAddress.findUnique({ where: { id: record.id } });
    expect(row!.lastSyncError).toBeTruthy();
  });

  it('refuses to sync a watched address belonging to another user', async () => {
    const record = await watchAddress('bc1qmine-not-yours');
    const other = await prisma.user.create({
      data: { email: `other-${Date.now()}@test.local`, passwordHash: 'x'.repeat(60) },
    });

    const result = await OnchainSyncService.syncWatchedAddress(other.id, record.id, endpoint);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);

    await prisma.user.delete({ where: { id: other.id } });
  });

  it('stores a balance larger than 21.47 BTC, which a 32-bit column would refuse', async () => {
    const huge = 1500 * SATS;
    fixture.addresses['bc1qwhale'] = {
      balance: 0,
      funded: huge,
      spent: 0,
      txCount: 1,
      txs: [tx({ txid: 'e1'.padEnd(64, '0'), outputs: [{ address: 'bc1qwhale', value: huge }] })],
    };

    const record = await watchAddress('bc1qwhale');
    const result = await OnchainSyncService.syncWatchedAddress(userId, record.id, endpoint);

    expect(result.ok).toBe(true);
    const row = await prisma.watchedAddress.findUnique({ where: { id: record.id } });
    expect(row!.balanceSats).toBe(BigInt(huge));
  });

  it('syncs every active address of a user', async () => {
    fixture.addresses['bc1qmulti1'] = {
      balance: 0,
      funded: SATS,
      spent: 0,
      txCount: 1,
      txs: [tx({ txid: 'f1'.padEnd(64, '0'), outputs: [{ address: 'bc1qmulti1', value: SATS }] })],
    };
    fixture.addresses['bc1qmulti2'] = {
      balance: 0,
      funded: 2 * SATS,
      spent: 0,
      txCount: 1,
      txs: [tx({ txid: 'f2'.padEnd(64, '0'), outputs: [{ address: 'bc1qmulti2', value: 2 * SATS }] })],
    };

    await watchAddress('bc1qmulti1');
    await watchAddress('bc1qmulti2');

    const results = await OnchainSyncService.syncUser(userId, endpoint);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await prisma.bitcoinTransaction.count({ where: { userId, source: 'onchain' } })).toBe(2);
  });

  it('skips inactive watched addresses', async () => {
    const record = await watchAddress('bc1qinactive');
    await prisma.watchedAddress.update({ where: { id: record.id }, data: { isActive: false } });

    const results = await OnchainSyncService.syncUser(userId, endpoint);
    expect(results).toHaveLength(0);
  });
});

describe('OnchainSyncService.resolveAddresses', () => {
  it('returns the hand-entered address even when no xpub is stored', async () => {
    const contexts = await OnchainSyncService.resolveAddresses({
      id: 1,
      walletId: null,
      address: 'bc1qsolo',
      xpub: null,
      scriptType: 'p2wpkh',
      gapLimit: 20,
      chain: 'mainnet',
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].address).toBe('bc1qsolo');
    expect(contexts[0].isPrimary).toBe(true);
  });

  it('derives receive and change chains from a stored xpub', async () => {
    const zpub =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    const normalized = parseXpub(zpub).xpub;
    const encrypted = OnchainSyncService.encryptXpubForStorage(normalized);

    const contexts = await OnchainSyncService.resolveAddresses({
      id: 1,
      walletId: 7,
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      xpub: encrypted,
      scriptType: 'p2wpkh',
      gapLimit: 3,
      chain: 'mainnet',
    });

    // gapLimit 3 -> 3 receive + 3 change; the primary is m/0/0 and dedupes.
    expect(contexts).toHaveLength(6);
    expect(contexts.some((c) => c.address === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toBe(true);
    expect(contexts.some((c) => c.address === 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el')).toBe(true);
    expect(contexts.every((c) => c.walletId === 7)).toBe(true);
  });

  it('still reads a plain, unencrypted xpub from an older row', async () => {
    const zpub =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    const contexts = await OnchainSyncService.resolveAddresses({
      id: 1,
      walletId: null,
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      xpub: zpub,
      scriptType: 'p2wpkh',
      gapLimit: 2,
      chain: 'mainnet',
    });
    expect(contexts.length).toBeGreaterThanOrEqual(4);
  });

  it('clamps a gap limit that is out of range', async () => {
    const zpub =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    const contexts = await OnchainSyncService.resolveAddresses({
      id: 1,
      walletId: null,
      // m/0/0 of this xpub, already in the derived set, so it must dedupe
      // rather than be counted twice.
      address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      xpub: zpub,
      scriptType: 'p2wpkh',
      gapLimit: 9999,
      chain: 'mainnet',
    });
    // Clamped to MAX_GAP_LIMIT (200) -> 200 receive + 200 change = 400 unique.
    expect(contexts.length).toBe(400);
    expect(new Set(contexts.map((c) => c.address)).size).toBe(400);
  });
});

describe('OnchainSyncService.encryption', () => {
  it('round-trips an xpub through the encryption service', () => {
    const xpub =
      'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yD6vDfKotXJmSTXd9Qd';
    const stored = OnchainSyncService.encryptXpubForStorage(xpub);
    expect(stored).not.toContain(xpub);
    expect(EncryptionService.decrypt(stored)).toBe(xpub);
  });
});
