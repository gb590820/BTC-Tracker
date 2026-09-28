/**
 * Serialisation helpers for the on-chain API.
 *
 * `WatchedAddress` stores balances as Prisma `BigInt` because a 32-bit integer
 * overflows at 21.47 BTC. `JSON.stringify` throws on a `bigint`, so every route
 * must go through these helpers: any object straight out of Prisma will fail to
 * serialise if a BigInt field is left untouched.
 *
 * Satoshis are exposed as strings, not numbers. A balance of 2.1e15 sats is
 * well inside the 2^53 safe-integer range, but strings make it explicit that the
 * value is an exact count of satoshis and not a rounded amount of BTC, and they
 * survive a future switch to a wider integer without a silent precision loss.
 */

const SATS_PER_BTC = 100_000_000;

export interface SerializedWatchedAddress {
  id: number;
  userId: number;
  walletId: number | null;
  wallet?: { id: number; name: string; type: string; emoji: string | null } | null;
  label: string;
  address: string;
  chain: string;
  scriptType: string;
  gapLimit: number;
  /** Never the xpub itself: it is a privacy-sensitive watch-only key. */
  hasXpub: boolean;
  xpubDerivationPath: string | null;
  balanceSats: string;
  fundedSats: string;
  spentSats: string;
  /** Convenience views of the same snapshot, already divided by 1e8. */
  balanceBtc: number;
  txCount: number;
  utxoCount: number;
  lastSyncedTxid: string | null;
  lastSyncedAddress: string | null;
  lastSyncBlock: number | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncCount: number;
  balanceSyncedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

type WatchedAddressRow = {
  id: number;
  userId: number;
  walletId: number | null;
  wallet?: { id: number; name: string; type: string; emoji: string | null } | null;
  label: string;
  address: string;
  chain: string;
  xpub: string | null;
  xpubDerivationPath: string | null;
  scriptType: string;
  gapLimit: number;
  balanceSats: bigint | number;
  fundedSats: bigint | number;
  spentSats: bigint | number;
  txCount: number;
  utxoCount: number;
  lastSyncedTxid: string | null;
  lastSyncedAddress: string | null;
  lastSyncBlock: number | null;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  lastSyncCount: number;
  balanceSyncedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function serializeWatchedAddress(row: WatchedAddressRow): SerializedWatchedAddress {
  const balanceSats = BigInt(row.balanceSats ?? 0);
  const fundedSats = BigInt(row.fundedSats ?? 0);
  const spentSats = BigInt(row.spentSats ?? 0);

  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    wallet: row.wallet ?? null,
    label: row.label,
    address: row.address,
    chain: row.chain,
    scriptType: row.scriptType,
    gapLimit: row.gapLimit,
    hasXpub: !!row.xpub,
    xpubDerivationPath: row.xpubDerivationPath,
    balanceSats: balanceSats.toString(),
    fundedSats: fundedSats.toString(),
    spentSats: spentSats.toString(),
    balanceBtc: Number(balanceSats) / SATS_PER_BTC,
    txCount: row.txCount,
    utxoCount: row.utxoCount,
    lastSyncedTxid: row.lastSyncedTxid,
    lastSyncedAddress: row.lastSyncedAddress,
    lastSyncBlock: row.lastSyncBlock,
    lastSyncAt: iso(row.lastSyncAt),
    lastSyncError: row.lastSyncError,
    lastSyncCount: row.lastSyncCount,
    balanceSyncedAt: iso(row.balanceSyncedAt),
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Strip the xpub from a transaction row.
 *
 * A txid is a public blockchain fact, so exposing it is fine, but the row also
 * carries the addresses it touched — which are exactly the addresses the user is
 * watching. They are only returned because the caller already owns the record;
 * the xpub column is never included in a response.
 */
export function serializeOnchainTransaction(row: Record<string, unknown>) {
  return {
    ...row,
    transactionDate:
      row.transactionDate instanceof Date ? row.transactionDate.toISOString() : row.transactionDate,
    blockTime: row.blockTime instanceof Date ? row.blockTime.toISOString() : row.blockTime,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}
