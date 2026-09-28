import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withAuth } from '@/lib/auth-helpers';
import {
  isPlausibleBitcoinAddress,
  classifyAddress,
  parseXpub,
  deriveAddresses,
  ScriptType,
  MAX_GAP_LIMIT,
} from '@/lib/onchain/address-derivation';
import { OnchainSyncService } from '@/lib/onchain/onchain-sync-service';
import { SettingsService } from '@/lib/settings-service';
import { serializeWatchedAddress } from '@/lib/onchain/serializers';

const VALID_SCRIPT_TYPES: ScriptType[] = ['p2pkh', 'p2wpkh-p2sh', 'p2wpkh'];
const VALID_CHAINS = ['mainnet', 'testnet', 'signet', 'regtest'];

/**
 * Guess the script type from a bare address.
 *
 * An xpub's version bytes are the authority whenever one is supplied. For an
 * address-only entry there is nothing to read, and legacy versus native-segwit
 * can still be told apart. P2SH is the ambiguous case — a 3... address is
 * wrapped segwit far more often than a bare multisig — so it maps to
 * p2wpkh-p2sh.
 */
function scriptTypeForAddress(address: string): ScriptType {
  switch (classifyAddress(address)) {
    case 'p2pkh':
      return 'p2pkh';
    case 'p2sh':
      return 'p2wpkh-p2sh';
    case 'segwit':
    default:
      return 'p2wpkh';
  }
}

function buildDerivationLabel(purpose: number | null, wasBracketed: boolean): string {
  const base = purpose ? `m/${purpose}h/0h/0h` : 'account key';
  return wasBracketed ? `${base} (bracketed export)` : base;
}

// GET /api/onchain/addresses - list the addresses the authenticated user watches
export async function GET(request: NextRequest) {
  return withAuth(request, async (userId) => {
    const rows = await prisma.watchedAddress.findMany({
      where: { userId },
      include: { wallet: { select: { id: true, name: true, type: true, emoji: true } } },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });

    return NextResponse.json({
      success: true,
      data: rows.map((row) => serializeWatchedAddress(row)),
    });
  });
}

/**
 * POST /api/onchain/addresses - start watching an address, optionally with an
 * account-level xpub.
 *
 * The xpub is validated and encrypted here and never returned. A wrong xpub is
 * the most likely user error and the most expensive one to debug later, so it is
 * rejected at write time with a message that says what to fix, instead of
 * producing an address set that quietly never matches anything.
 */
export async function POST(request: NextRequest) {
  return withAuth(request, async (userId) => {
    let body: {
      address?: string;
      xpub?: string;
      label?: string;
      walletId?: number | null;
      scriptType?: string;
      gapLimit?: number;
      chain?: string;
    };

    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const address = (body.address || '').trim();
    const xpubInput = (body.xpub || '').trim();
    const label = (body.label || '').trim().slice(0, 100);
    const chain = VALID_CHAINS.includes(body.chain || '') ? (body.chain as string) : 'mainnet';

    if (!address && !xpubInput) {
      return NextResponse.json(
        { success: false, error: 'Provide an address, an xpub, or both' },
        { status: 400 }
      );
    }

    if (address && !isPlausibleBitcoinAddress(address)) {
      return NextResponse.json(
        { success: false, error: `"${address}" does not look like a Bitcoin address` },
        { status: 400 }
      );
    }

    const gapLimit = Number(body.gapLimit ?? 20);
    if (!Number.isInteger(gapLimit) || gapLimit < 1 || gapLimit > MAX_GAP_LIMIT) {
      return NextResponse.json(
        { success: false, error: `gapLimit must be an integer between 1 and ${MAX_GAP_LIMIT}` },
        { status: 400 }
      );
    }

    let scriptType: ScriptType = body.scriptType
      ? (body.scriptType as ScriptType)
      : address
        ? scriptTypeForAddress(address)
        : 'p2wpkh';
    let derivationPath: string | null = null;
    let encryptedXpub: string | null = null;
    // Kept in memory only for the duration of the request, to derive the first
    // receive address below. The plaintext never touches the database.
    let parsedXpub: ReturnType<typeof parseXpub> | null = null;

    if (xpubInput) {
      try {
        parsedXpub = parseXpub(xpubInput);
      } catch (error) {
        return NextResponse.json(
          {
            success: false,
            error: error instanceof Error ? error.message : 'Invalid extended public key',
          },
          { status: 400 }
        );
      }

      // The xpub's own version bytes describe the whole wallet, so they override
      // anything inferred from the address.
      scriptType = parsedXpub.scriptType;
      derivationPath = buildDerivationLabel(parsedXpub.purpose, parsedXpub.wasBracketed);
      encryptedXpub = OnchainSyncService.encryptXpubForStorage(parsedXpub.xpub);

      if (parsedXpub.chain === 'testnet' && chain === 'mainnet') {
        return NextResponse.json(
          {
            success: false,
            error: 'That is a testnet key. Set chain to "testnet" before saving it.',
          },
          { status: 400 }
        );
      }
    }

    if (VALID_SCRIPT_TYPES.indexOf(scriptType) < 0) {
      return NextResponse.json(
        { success: false, error: `scriptType must be one of ${VALID_SCRIPT_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    // The wallet association is optional, but if given it must belong to the
    // caller — never trust a walletId from the request body.
    let walletId: number | null = null;
    if (body.walletId !== undefined && body.walletId !== null) {
      const requested = Number(body.walletId);
      if (!Number.isInteger(requested)) {
        return NextResponse.json(
          { success: false, error: 'walletId must be an integer' },
          { status: 400 }
        );
      }
      const wallet = await prisma.wallet.findFirst({
        where: { id: requested, userId },
        select: { id: true },
      });
      if (!wallet) {
        return NextResponse.json({ success: false, error: 'Wallet not found' }, { status: 404 });
      }
      walletId = wallet.id;
    }

    // When only an xpub was given, store the first receive address as the row's
    // primary so the record is self-describing even for address-only readers.
    let primaryAddress = address;
    if (!primaryAddress && parsedXpub) {
      const derived = deriveAddresses(
        parsedXpub.xpub,
        parsedXpub.scriptType,
        1,
        parsedXpub.chain
      );
      const first = derived.find((d) => d.chainIndex === 0 && d.index === 0);
      if (!first) {
        return NextResponse.json(
          { success: false, error: 'Could not derive a first address from that xpub' },
          { status: 400 }
        );
      }
      primaryAddress = first.address;
    }

    const existing = await prisma.watchedAddress.findFirst({
      where: { userId, chain, address: primaryAddress },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'This address is already being watched' },
        { status: 409 }
      );
    }

    const created = await prisma.watchedAddress.create({
      data: {
        userId,
        walletId,
        label,
        address: primaryAddress,
        chain,
        xpub: encryptedXpub,
        xpubDerivationPath: derivationPath,
        scriptType,
        gapLimit,
      },
    });

    // Try an immediate sync so the user sees history without waiting for the
    // scheduler — but never fail the request on it. The endpoint may be down, or
    // deliberately pointed at a self-hosted node that is not up yet.
    let message: string | undefined;
    try {
      const settings = await SettingsService.loadSettings();
      const config = settings.onchain;
      if (config?.enabled) {
        const result = await OnchainSyncService.syncWatchedAddress(
          userId,
          created.id,
          config.esploraEndpoint,
          config.requestTimeoutMs
        );
        message = result.ok
          ? `Imported ${result.txsImported} transaction(s).`
          : `Address saved, but the first sync failed: ${result.error}`;
      } else {
        message = 'Address saved. Enable on-chain syncing in Settings to fetch its history.';
      }
    } catch (error) {
      message = `Address saved, but the first sync could not run: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    const fresh = await prisma.watchedAddress.findUnique({
      where: { id: created.id },
      include: { wallet: { select: { id: true, name: true, type: true, emoji: true } } },
    });

    return NextResponse.json(
      { success: true, data: serializeWatchedAddress(fresh!), message },
      { status: 201 }
    );
  });
}
