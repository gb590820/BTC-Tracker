import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth } from '@/lib/auth-helpers';
import { OnchainSyncService } from '@/lib/onchain/onchain-sync-service';
import { SettingsService } from '@/lib/settings-service';
import { BitcoinPriceService } from '@/lib/bitcoin-price-service';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/onchain/addresses/[id]/sync - sync one watched address now.
 *
 * The scheduler is the normal path; this exists so a user who just added an
 * address, or who suspects they missed a transaction, does not have to wait for
 * the next tick. It works whether or not automatic syncing is enabled, because
 * it is an explicit user action.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  return withAuth(request, async (userId) => {
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid id' }, { status: 400 });
    }

    const existing = await prisma.watchedAddress.findFirst({
      where: { id, userId },
      select: { id: true, address: true, isActive: true },
    });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Watched address not found' }, { status: 404 });
    }

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

    const result = await OnchainSyncService.syncWatchedAddress(userId, id, endpoint, timeoutMs);

    if (!result.ok) {
      // 502: the request itself was valid, the upstream blockchain backend was
      // not. That distinction matters to a client retrying with backoff.
      return NextResponse.json(
        { success: false, error: result.error, data: result },
        { status: 502 }
      );
    }

    // Keep the portfolio in step with what was just imported.
    if (result.txsImported > 0) {
      try {
        await BitcoinPriceService.calculateAndStorePortfolioSummary(userId);
      } catch (error) {
        console.error('[ONCHAIN] Portfolio refresh after manual sync failed:', error);
      }
    }

    return NextResponse.json({ success: true, data: result });
  });
}
