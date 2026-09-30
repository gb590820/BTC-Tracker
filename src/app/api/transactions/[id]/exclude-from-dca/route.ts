import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { BitcoinPriceService } from '@/lib/bitcoin-price-service';
import { withAuth } from '@/lib/auth-helpers';

/**
 * Undo "Include in DCA" for a scanned on-chain receive that was promoted to a
 * BUY by mistake. The row goes back to a TRANSFER_IN: it leaves the DCA
 * analysis (BUY-only) but keeps its inferred cost basis, so it still counts
 * in "Total invested" and is not re-promoted by the on-chain reconciliation
 * (which only touches rows whose amount/fees/transferType drift).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return withAuth(request, async (userId) => {
    const params = await context.params;
    const transactionId = parseInt(params.id);

    if (isNaN(transactionId)) {
      return NextResponse.json(
        { success: false, error: 'Invalid transaction ID' },
        { status: 400 }
      );
    }

    const transaction = await prisma.bitcoinTransaction.findFirst({
      where: { id: transactionId, userId },
    });

    if (!transaction) {
      return NextResponse.json(
        { success: false, error: 'Transaction not found' },
        { status: 404 }
      );
    }

    const isPromotedOnchainBuy =
      transaction.type === 'BUY' &&
      transaction.source === 'onchain' &&
      transaction.transferType === 'TRANSFER_IN' &&
      transaction.originalTotalAmount !== null &&
      transaction.originalTotalAmount > 0;

    if (!isPromotedOnchainBuy) {
      return NextResponse.json(
        {
          success: false,
          error: 'Only on-chain receives promoted to BUY can be excluded from DCA',
          message: 'This transaction is not an on-chain receive included in DCA.',
        },
        { status: 400 }
      );
    }

    const updated = await prisma.bitcoinTransaction.update({
      where: { id: transactionId },
      data: { type: 'TRANSFER' },
    });

    try {
      await BitcoinPriceService.calculateAndStorePortfolioSummary(userId);
    } catch (error) {
      console.error(`Failed to recalc portfolio after excluding tx ${transactionId} from DCA:`, error);
    }

    return NextResponse.json({
      success: true,
      data: { id: updated.id, type: updated.type },
      message: 'Transaction excluded from DCA',
    });
  });
}