import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth-helpers';
import { OnchainSyncService } from '@/lib/onchain/onchain-sync-service';
import { SettingsService } from '@/lib/settings-service';
import { BitcoinPriceService } from '@/lib/bitcoin-price-service';

/**
 * POST /api/onchain/sync - sync every watched address of the caller at once.
 *
 * Scoped to `userId` on purpose: one user clicking "sync" must not trigger a
 * global pass over every other account's addresses.
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (userId) => {
    let endpoint: string;
    let timeoutMs: number | undefined;
    try {
      const settings = await SettingsService.loadSettings();
      endpoint = settings.onchain?.esploraEndpoint || 'https://mempool.space/api';
      timeoutMs = settings.onchain?.requestTimeoutMs;
    } catch {
      return NextResponse.json(
        { success: false, error: 'Could not read the on-chain settings' },
        { status: 500 }
      );
    }

    const results = await OnchainSyncService.syncUser(userId, endpoint, timeoutMs);

    const txsImported = results.reduce((sum, r) => sum + r.txsImported, 0);
    const failed = results.filter((r) => !r.ok).length;

    if (txsImported > 0) {
      try {
        await BitcoinPriceService.calculateAndStorePortfolioSummary(userId);
      } catch (error) {
        console.error('[ONCHAIN] Portfolio refresh after sync failed:', error);
      }
    }

    return NextResponse.json({
      success: failed === 0,
      data: {
        addresses: results.length,
        txsImported,
        failed,
        results,
      },
    });
  });
}
