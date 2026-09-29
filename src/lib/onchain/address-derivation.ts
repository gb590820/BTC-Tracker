/**
 * BIP32 derivation of watch-only addresses from an account-level extended
 * public key.
 *
 * Why this exists: watching a single receive address is not enough for
 * self-custody. When you spend from `bc1qAAAA...`, the remainder goes to a
 * freshly derived change address that the receive address alone never reveals.
 * Deriving both chains (external = 0/k, internal = 1/k) up to a gap limit is
 * what keeps the tracked total equal to the real balance.
 *
 * No gap-limit *scan* is needed on the server side: electrs answers
 * `GET /address/:a` instantly for any address, so we simply ask about all
 * `2 * gapLimit` derived addresses and ignore the empty ones.
 */

import { HDKey } from '@scure/bip32';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';

export type Chain = 'mainnet' | 'testnet';
export type ScriptType = 'p2pkh' | 'p2wpkh-p2sh' | 'p2wpkh';

export interface XpubInfo {
  /** Normalised to the plain BIP32 public version bytes, for @scure/bip32. */
  xpub: string;
  /** The key exactly as pasted, for display. */
  original: string;
  scriptType: ScriptType;
  chain: Chain;
  /** BIP32 depth byte: 3 for an account key such as [84h/0h/0h]. */
  depth: number;
  /** BIP32 purpose implied by the version bytes: 44 / 49 / 84. */
  purpose: number | null;
  /** True when the key arrived wrapped in Bitcoin Core / Ledger Live brackets. */
  wasBracketed: boolean;
}

const base58c = createBase58check(sha256);

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/** 20-byte witness program -> bech32 v0 P2WPKH address (bc1q...). */
function encodeP2WPKH(program: Uint8Array, chain: Chain): string {
  const hrp = chain === 'mainnet' ? 'bc' : 'tb';
  // The witness version is a standalone 5-bit word, not a packed byte.
  return bech32.encode(hrp, [0, ...bech32.toWords(program)], 90);
}

/** 32-byte witness program -> bech32m v1 P2TR address (bc1p...). */
function encodeP2TR(program: Uint8Array, chain: Chain): string {
  const hrp = chain === 'mainnet' ? 'bc' : 'tb';
  return bech32m.encode(hrp, [1, ...bech32m.toWords(program)], 90);
}

/** Compressed public key -> P2PKH base58 address (1...). */
export function pubkeyToP2PKH(pubkey: Uint8Array, chain: Chain): string {
  const version = chain === 'mainnet' ? 0x00 : 0x6f;
  return base58c.encode(concatBytes(new Uint8Array([version]), hash160(pubkey)));
}

/** Compressed public key -> P2WPKH-in-P2SH address (3...). */
export function pubkeyToP2WPKHSH(pubkey: Uint8Array, chain: Chain): string {
  const witnessProgram = hash160(pubkey);
  // P2WPKH witness script: OP_0 PUSH20 <keyhash>
  const redeemScript = concatBytes(new Uint8Array([0x00, 0x14]), witnessProgram);
  const scriptHash = hash160(redeemScript);
  const version = chain === 'mainnet' ? 0x05 : 0xc4;
  return base58c.encode(concatBytes(new Uint8Array([version]), scriptHash));
}

export function pubkeyToAddress(pubkey: Uint8Array, scriptType: ScriptType, chain: Chain): string {
  switch (scriptType) {
    case 'p2pkh':
      return pubkeyToP2PKH(pubkey, chain);
    case 'p2wpkh-p2sh':
      return pubkeyToP2WPKHSH(pubkey, chain);
    case 'p2wpkh':
    default:
      return encodeP2WPKH(hash160(pubkey), chain);
  }
}

/**
 * Extended public key version bytes, per the Electrum reference table. The
 * four-character prefix is just Base58 of these four bytes, so a zpub and an
 * xpub are identical key material re-serialized for a different script type.
 */
const PUBLIC_KEY_VERSIONS: Record<
  string,
  { bytes: number; scriptType: ScriptType; purpose: number; chain: Chain }
> = {
  xpub: { bytes: 0x0488b21e, scriptType: 'p2pkh', purpose: 44, chain: 'mainnet' },
  ypub: { bytes: 0x049d7cb2, scriptType: 'p2wpkh-p2sh', purpose: 49, chain: 'mainnet' },
  zpub: { bytes: 0x04b24746, scriptType: 'p2wpkh', purpose: 84, chain: 'mainnet' },
  tpub: { bytes: 0x043587cf, scriptType: 'p2pkh', purpose: 44, chain: 'testnet' },
  upub: { bytes: 0x044a5262, scriptType: 'p2wpkh-p2sh', purpose: 49, chain: 'testnet' },
  vpub: { bytes: 0x045f1cf6, scriptType: 'p2wpkh', purpose: 84, chain: 'testnet' },
};

/**
 * Keys whose redeem script is P2WSH. They are recognised so the user gets a
 * precise "not supported" message instead of a generic parse failure, but they
 * are deliberately absent from PUBLIC_KEY_VERSIONS: deriving a P2WSH address
 * needs the witness script, which an account xpub cannot reconstruct.
 */
const UNSUPPORTED_PREFIXES: Record<string, string> = {
  Ypub: 'P2WSH-in-P2SH (Ypub)',
  Zpub: 'P2WSH (Zpub)',
  Upub: 'P2WSH-in-P2SH on testnet (Upub)',
  Vpub: 'P2WSH on testnet (Vpub)',
};

const PLAIN_PUBLIC_VERSION: Record<Chain, number> = {
  mainnet: 0x0488b21e,
  testnet: 0x043587cf,
};

/**
 * @scure/bip32 validates the version bytes of every key it loads and defaults
 * to mainnet, so testnet keys have to be announced explicitly.
 */
const BIP32_VERSIONS: Record<Chain, { private: number; public: number }> = {
  mainnet: { private: 0x0488ade4, public: 0x0488b21e },
  testnet: { private: 0x04358394, public: 0x043587cf },
};

/**
 * Re-serialize a 78-byte extended key under a different version prefix.
 *
 * The four version bytes live at the front of the decoded payload, so
 * re-labelling a zpub as an xpub is just a rewrite of bytes 0..3 followed by a
 * normal Base58Check encode.
 */
function reencodeWithVersion(decoded: Uint8Array, version: number): string {
  const repacked = new Uint8Array(decoded);
  repacked[0] = (version >>> 24) & 0xff;
  repacked[1] = (version >>> 16) & 0xff;
  repacked[2] = (version >>> 8) & 0xff;
  repacked[3] = version & 0xff;
  return base58c.encode(repacked);
}

const BRACKETED_RE = /^\s*\[([^\]]+)\]\s*([A-Za-z0-9]+)\s*$/;

/**
 * Parse a user-supplied extended public key.
 *
 * Accepts what hardware wallets and Bitcoin Core actually export:
 *   zpub6... / xpub6... / ypub6...   (bare)
 *   [84h/0h/0h]zpub6...               (Bitcoin Core, Ledger Live)
 *
 * The script type is inferred from the version bytes, so the caller does not
 * have to know that a `bc1q...` output means a zpub.
 */
export function parseXpub(input: string): XpubInfo {
  const raw = (input || '').trim();
  if (!raw) {
    throw new Error('Extended public key is empty');
  }

  let body = raw;
  let wasBracketed = false;

  const bracketed = BRACKETED_RE.exec(raw);
  if (bracketed) {
    body = bracketed[2];
    wasBracketed = true;
  }

  if (body.startsWith('xprv') || body.startsWith('yprv') || body.startsWith('zprv') || body.startsWith('tprv')) {
    throw new Error(
      'This looks like an extended PRIVATE key. Only watch-only public keys (xpub/zpub/ypub) are accepted.'
    );
  }

  const prefix = body.slice(0, 4);
  const known = PUBLIC_KEY_VERSIONS[prefix];
  if (!known) {
    const unsupported = UNSUPPORTED_PREFIXES[prefix];
    if (unsupported) {
      throw new Error(
        `${unsupported} accounts are not supported yet. Export the account key as xpub, ypub or zpub instead.`
      );
    }
    throw new Error(
      `Unrecognised extended key prefix "${prefix}". Expected xpub, ypub or zpub (mainnet), tpub, upub or vpub (testnet).`
    );
  }

  let decoded: Uint8Array;
  try {
    decoded = base58c.decode(body);
  } catch {
    throw new Error('Extended public key failed its Base58Check checksum. Re-copy it from your wallet.');
  }

  if (decoded.length !== 78) {
    throw new Error(`Malformed extended public key: expected 78 bytes, got ${decoded.length}`);
  }

  const depth = decoded[4];
  // Re-serialize with the plain BIP32 prefix so @scure/bip32 accepts the key.
  const xpub = reencodeWithVersion(decoded, PLAIN_PUBLIC_VERSION[known.chain]);

  return {
    xpub,
    original: raw,
    scriptType: known.scriptType,
    chain: known.chain,
    depth,
    purpose: known.purpose,
    wasBracketed,
  };
}

export interface DerivedAddress {
  address: string;
  /** 0 = receive/external, 1 = change/internal. */
  chainIndex: 0 | 1;
  index: number;
  path: string;
}

export const MAX_GAP_LIMIT = 200;

/**
 * Human label for the stored xpub column, mirroring what wallets export:
 * `m/84h/0h/0h` for a native-segwit account key, or `account key` when the
 * purpose could not be inferred. A bracketed export ([84h/0h/0h]zpub…) is
 * flagged so it can be told apart from a bare one.
 */
export function buildDerivationLabel(purpose: number | null, wasBracketed: boolean): string {
  const base = purpose ? `m/${purpose}h/0h/0h` : 'account key';
  return wasBracketed ? `${base} (bracketed export)` : base;
}

/**
 * Derive the receive and change addresses of an account-level xpub.
 *
 * The key is assumed to be an *account* key (e.g. `[84h/0h/0h]zpub6...`), which
 * is what Ledger Live, Bitcoin Core and hardware wallets export. Children are
 * then addressed as `0/k` and `1/k` from that account node.
 */
export function deriveAddresses(
  xpub: string,
  scriptType: ScriptType,
  gapLimit: number,
  chain: Chain = 'mainnet'
): DerivedAddress[] {
  if (!Number.isInteger(gapLimit) || gapLimit < 1 || gapLimit > MAX_GAP_LIMIT) {
    throw new Error(`gapLimit must be an integer between 1 and ${MAX_GAP_LIMIT}, got ${gapLimit}`);
  }

  const account = HDKey.fromExtendedKey(xpub, BIP32_VERSIONS[chain]);
  const results: DerivedAddress[] = [];

  for (const chainIndex of [0, 1] as const) {
    for (let index = 0; index < gapLimit; index++) {
      try {
        const child = account.derive(`m/${chainIndex}/${index}`);
        const pubkey = child.publicKey;
        if (!pubkey) {
          continue;
        }
        results.push({
          address: pubkeyToAddress(Uint8Array.from(pubkey), scriptType, chain),
          chainIndex,
          index,
          path: `m/${chainIndex}/${index}`,
        });
      } catch {
        // Deriving a hardened child from a public key is impossible, and one bad
        // index must not abort the whole derivation pass.
        continue;
      }
    }
  }

  return results;
}

// Legacy base58 families. The leading version character is fixed per family
// (1 = P2PKH, 3 = P2SH); a combined [13] / [23] class would let P2PKH claim
// every P2SH address.
const P2PKH_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const P2SH_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const SEGWIT_RE = /^(bc|tb)1[02-9ac-hj-np-z]{11,71}$/i;

export type AddressKind = 'p2pkh' | 'p2sh' | 'segwit' | 'unknown';

/**
 * Cheap syntactic check of a Bitcoin address.
 *
 * This is a format gate, not a validity proof: esplora remains the authority on
 * whether a checksum actually resolves, and an address that passes here but is
 * rejected upstream simply yields no history.
 */
export function classifyAddress(address: string): AddressKind {
  const value = (address || '').trim();
  if (!value) {
    return 'unknown';
  }
  if (P2PKH_RE.test(value)) {
    return 'p2pkh';
  }
  if (P2SH_RE.test(value)) {
    return 'p2sh';
  }
  if (SEGWIT_RE.test(value)) {
    return 'segwit';
  }
  return 'unknown';
}

export function isPlausibleBitcoinAddress(address: string): boolean {
  return classifyAddress(address) !== 'unknown';
}

export { encodeP2TR, encodeP2WPKH };
