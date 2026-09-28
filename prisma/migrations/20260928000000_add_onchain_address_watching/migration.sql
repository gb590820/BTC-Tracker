-- CreateTable
CREATE TABLE "watched_addresses" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "wallet_id" INTEGER,
    "label" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'mainnet',
    "xpub" TEXT,
    "xpub_derivation_path" TEXT,
    "script_type" TEXT NOT NULL DEFAULT 'p2wpkh',
    "gap_limit" INTEGER NOT NULL DEFAULT 20,
    "last_synced_txid" TEXT,
    "last_synced_address" TEXT,
    "last_sync_block" INTEGER,
    "last_sync_at" DATETIME,
    "last_sync_error" TEXT,
    "last_sync_count" INTEGER NOT NULL DEFAULT 0,
    -- BIGINT, not INTEGER: Prisma's SQLite connector infers the JS type from
    -- the *declared column type*, so a plain INTEGER column is read back as a
    -- 32-bit number and Prisma refuses to write anything above 2_147_483_647
    -- (21.47 BTC). Balances in sats need the full 64-bit range.
    "balance_sats" BIGINT NOT NULL DEFAULT 0,
    "funded_sats" BIGINT NOT NULL DEFAULT 0,
    "spent_sats" BIGINT NOT NULL DEFAULT 0,
    "tx_count" INTEGER NOT NULL DEFAULT 0,
    "utxo_count" INTEGER NOT NULL DEFAULT 0,
    "balance_synced_at" DATETIME,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,

    CONSTRAINT "watched_addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "watched_addresses_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "watched_addresses_user_id_chain_address_key" ON "watched_addresses"("user_id", "chain", "address");

-- CreateIndex
CREATE INDEX "watched_addresses_user_id_idx" ON "watched_addresses"("user_id");

-- CreateIndex
CREATE INDEX "watched_addresses_wallet_id_idx" ON "watched_addresses"("wallet_id");

-- CreateIndex
CREATE INDEX "watched_addresses_is_active_idx" ON "watched_addresses"("is_active");

-- AlterTable: on-chain provenance columns.
-- SQLite cannot add a UNIQUE constraint through ALTER TABLE ADD COLUMN, so the
-- per-user txid uniqueness is created as a separate unique index below.
ALTER TABLE "bitcoin_transactions" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "bitcoin_transactions" ADD COLUMN "txid" TEXT;
ALTER TABLE "bitcoin_transactions" ADD COLUMN "block_height" INTEGER;
ALTER TABLE "bitcoin_transactions" ADD COLUMN "block_time" DATETIME;
ALTER TABLE "bitcoin_transactions" ADD COLUMN "confirmations" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bitcoin_transactions" ADD COLUMN "is_replaced" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bitcoin_transactions" ADD COLUMN "from_address" TEXT;
ALTER TABLE "bitcoin_transactions" ADD COLUMN "to_address" TEXT;
ALTER TABLE "bitcoin_transactions" ADD COLUMN "watched_address_id" INTEGER REFERENCES "watched_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "bitcoin_transactions_user_id_txid_key" ON "bitcoin_transactions"("user_id", "txid");

-- CreateIndex
CREATE INDEX "bitcoin_transactions_txid_idx" ON "bitcoin_transactions"("txid");

-- CreateIndex
CREATE INDEX "bitcoin_transactions_watched_address_id_idx" ON "bitcoin_transactions"("watched_address_id");
