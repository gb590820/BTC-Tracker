import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth } from '@/lib/auth-helpers';
import { OnchainScheduler } from '@/lib/onchain/onchain-scheduler';
import { SettingsService } from '@/lib/settings-service';

/**
 * GET /api/onchain/status - scheduler state and a liveness probe.
 *
 * The probe is opt-in through `?test=1` because it makes a real outbound request
 * to whatever endpoint is configured; the status half is free.
 */
export async function GET(request: NextRequest) {
  return withAuth(request, async (userId) => {
    const settings = await SettingsService.loadSettings();
    const config = settings.onchain;

    const watchedCount = await prisma.watchedAddress.count({
      where: { userId, isActive: true },
    });

    const onchainTransactionCount = await prisma.bitcoinTransaction.count({
      where: { userId, source: 'onchain' },
    });

    const pendingCount = await prisma.bitcoinTransaction.count({
      where: { userId, source: 'onchain', confirmations: 0, isReplaced: false },
    });

    const replacedCount = await prisma.bitcoinTransaction.count({
      where: { userId, source: 'onchain', isReplaced: true },
    });

    const body: Record<string, unknown> = {
      success: true,
      data: {
        enabled: config?.enabled ?? false,
        endpoint: config?.esploraEndpoint ?? null,
        syncIntervalMinutes: config?.syncIntervalMinutes ?? null,
        gapLimit: config?.gapLimit ?? null,
        watchedAddresses: watchedCount,
        importedTransactions: onchainTransactionCount,
        pendingTransactions: pendingCount,
        replacedTransactions: replacedCount,
        scheduler: OnchainScheduler.getStatus(),
      },
    };

    if (request.nextUrl.searchParams.get('test') === '1') {
      try {
        body.connection = await OnchainScheduler.testConnection();
      } catch (error) {
        body.connection = {
          reachable: false,
          tipHeight: null,
          endpoint: config?.esploraEndpoint ?? null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return NextResponse.json(body);
  });
}
