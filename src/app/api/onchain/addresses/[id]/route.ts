import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth } from '@/lib/auth-helpers';
import { OnchainSyncService } from '@/lib/onchain/onchain-sync-service';
import { parseXpub, MAX_GAP_LIMIT, ScriptType } from '@/lib/onchain/address-derivation';
import { serializeWatchedAddress } from '@/lib/onchain/serializers';

const VALID_SCRIPT_TYPES: ScriptType[] = ['p2pkh', 'p2wpkh-p2sh', 'p2wpkh'];

type RouteContext = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/onchain/addresses/[id]
export async function GET(request: NextRequest, context: RouteContext) {
  return withAuth(request, async (userId) => {
    const { id: rawId } = await context.params;
    const id = parseId(rawId);
    if (id === null) {
      return NextResponse.json({ success: false, error: 'Invalid id' }, { status: 400 });
    }

    // userId in the filter: watching the same address as another user must not
    // expose their record.
    const row = await prisma.watchedAddress.findFirst({
      where: { id, userId },
      include: { wallet: { select: { id: true, name: true, type: true, emoji: true } } },
    });

    if (!row) {
      return NextResponse.json({ success: false, error: 'Watched address not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: serializeWatchedAddress(row) });
  });
}

/**
 * PATCH /api/onchain/addresses/[id]
 *
 * Only the mutable metadata is editable. The address, the chain and the derived
 * address set are deliberately immutable: changing them in place would leave
 * transactions already imported under the old address attached to a record that
 * no longer describes them. To follow a different key, create a new entry and
 * remove this one.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  return withAuth(request, async (userId) => {
    const { id: rawId } = await context.params;
    const id = parseId(rawId);
    if (id === null) {
      return NextResponse.json({ success: false, error: 'Invalid id' }, { status: 400 });
    }

    const existing = await prisma.watchedAddress.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Watched address not found' }, { status: 404 });
    }

    let body: {
      label?: string;
      walletId?: number | null;
      gapLimit?: number;
      isActive?: boolean;
      xpub?: string | null;
      // Accepted by the type only so they can be detected and rejected with a
      // helpful message instead of being silently ignored.
      address?: string;
      chain?: string;
      scriptType?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const data: Record<string, unknown> = {};

    if (body.label !== undefined) {
      data.label = String(body.label).trim().slice(0, 100);
    }

    if (body.isActive !== undefined) {
      data.isActive = !!body.isActive;
    }

    if (body.gapLimit !== undefined) {
      const gapLimit = Number(body.gapLimit);
      if (!Number.isInteger(gapLimit) || gapLimit < 1 || gapLimit > MAX_GAP_LIMIT) {
        return NextResponse.json(
          { success: false, error: `gapLimit must be an integer between 1 and ${MAX_GAP_LIMIT}` },
          { status: 400 }
        );
      }
      data.gapLimit = gapLimit;
    }

    if (body.walletId !== undefined) {
      if (body.walletId === null) {
        data.walletId = null;
      } else {
        const requested = Number(body.walletId);
        const wallet = await prisma.wallet.findFirst({
          where: { id: requested, userId },
          select: { id: true },
        });
        if (!wallet) {
          return NextResponse.json({ success: false, error: 'Wallet not found' }, { status: 404 });
        }
        data.walletId = wallet.id;
      }
    }

    // A new xpub replaces the old one and is re-encrypted; the existing sync
    // cursor is cleared because it refers to the previous address set.
    if (body.xpub !== undefined) {
      if (body.xpub === null || body.xpub === '') {
        data.xpub = null;
        data.xpubDerivationPath = null;
        data.lastSyncedTxid = null;
      } else {
        let parsed;
        try {
          parsed = parseXpub(String(body.xpub).trim());
        } catch (error) {
          return NextResponse.json(
            {
              success: false,
              error: error instanceof Error ? error.message : 'Invalid extended public key',
            },
            { status: 400 }
          );
        }
        if (VALID_SCRIPT_TYPES.indexOf(parsed.scriptType) < 0) {
          return NextResponse.json(
            { success: false, error: 'Unsupported script type for that key' },
            { status: 400 }
          );
        }
        data.xpub = OnchainSyncService.encryptXpubForStorage(parsed.xpub);
        data.xpubDerivationPath = parsed.purpose ? `m/${parsed.purpose}h/0h/0h` : 'account key';
        data.scriptType = parsed.scriptType;
        data.lastSyncedTxid = null;
      }
    }

    if (body.address !== undefined || body.chain !== undefined || body.scriptType !== undefined) {
      const conflicting = [
        body.address !== undefined ? 'address' : null,
        body.chain !== undefined ? 'chain' : null,
        body.scriptType !== undefined && body.xpub === undefined ? 'scriptType' : null,
      ].filter(Boolean);
      if (conflicting.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: `${conflicting.join(', ')} cannot be changed. Create a new watched address instead, so the transactions already imported stay correctly attributed.`,
          },
          { status: 409 }
        );
      }
    }

    const updated = await prisma.watchedAddress.update({
      where: { id },
      data,
      include: { wallet: { select: { id: true, name: true, type: true, emoji: true } } },
    });

    return NextResponse.json({ success: true, data: serializeWatchedAddress(updated) });
  });
}

/**
 * DELETE /api/onchain/addresses/[id]
 *
 * Removes the watch record only. Transactions that were already imported stay
 * in the portfolio: they are real history, and silently deleting a user's
 * holdings because they un-watched an address would be destructive.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  return withAuth(request, async (userId) => {
    const { id: rawId } = await context.params;
    const id = parseId(rawId);
    if (id === null) {
      return NextResponse.json({ success: false, error: 'Invalid id' }, { status: 400 });
    }

    const existing = await prisma.watchedAddress.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Watched address not found' }, { status: 404 });
    }

    const importedCount = await prisma.bitcoinTransaction.count({
      where: { userId, watchedAddressId: id },
    });

    // Detach rather than cascade: the transactions remain, but the link to the
    // deleted record is cleared so no row points at a missing parent.
    await prisma.$transaction([
      prisma.bitcoinTransaction.updateMany({
        where: { userId, watchedAddressId: id },
        data: { watchedAddressId: null },
      }),
      prisma.watchedAddress.delete({ where: { id } }),
    ]);

    return NextResponse.json({
      success: true,
      message:
        importedCount > 0
          ? `Stopped watching. ${importedCount} imported transaction(s) were kept in your portfolio.`
          : 'Stopped watching this address.',
    });
  });
}
