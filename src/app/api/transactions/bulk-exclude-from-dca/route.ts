import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { BitcoinPriceService } from '@/lib/bitcoin-price-service';
import { withAuth } from '@/lib/auth-helpers';

/**
 * Bulk version of "Exclude from DCA": demote on-chain receives that were
 * previously promoted to BUY, skipping rows that do not qualify.
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (userId) => {
    let ids: unknown;
    try {
      const body = await request.json();
      ids = body?.ids;
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isInteger(id))) {
      return NextResponse.json(
        { success: false, error: 'A non-empty array of transaction ids is required' },
        { status: 400 }
      );
    }

    const selectedIds = ids as number[];
    const transactions = await prisma.bitcoinTransaction.findMany({
      where: { id: { in: selectedIds }, userId },
    });

    const eligible = transactions.filter((transaction) =>
      transaction.type === 'BUY' &&
      transaction.source === 'onchain' &&
      transaction.transferType === 'TRANSFER_IN' &&
      transaction.originalTotalAmount !== null &&
      transaction.originalTotalAmount > 0
    );

    if (eligible.length > 0) {
      await prisma.bitcoinTransaction.updateMany({
        where: { id: { in: eligible.map((transaction) => transaction.id) }, userId },
        data: { type: 'TRANSFER' },
      });

      try {
        await BitcoinPriceService.calculateAndStorePortfolioSummary(userId);
      } catch (error) {
        console.error(`Failed to bulk-exclude ${eligible.length} transactions from DCA:`, error);
      }
    }

    const skipped = transactions.length - eligible.length;
    const message = eligible.length > 0
      ? `${eligible.length} transaction(s) excluded from DCA`
      : 'None of the selected transactions can be excluded from DCA (only promoted on-chain receives qualify)';

    return NextResponse.json({
      success: true,
      data: { excluded: eligible.length, skipped, totalSelected: selectedIds.length },
      message,
    });
  });
}
