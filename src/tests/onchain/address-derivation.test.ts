/**
 * Address derivation tests.
 *
 * The addresses produced here end up in the user's portfolio, so the encoders
 * are checked against the published BIP test vectors rather than against
 * themselves. A wrong bech32 checksum or a wrong version byte would silently
 * produce a balance of zero forever, which is exactly the failure a user would
 * report as "my BTC disappeared".
 */

import {
  parseXpub,
  deriveAddresses,
  classifyAddress,
  isPlausibleBitcoinAddress,
  pubkeyToP2PKH,
  pubkeyToP2WPKHSH,
  encodeP2WPKH,
  encodeP2TR,
} from '@/lib/onchain/address-derivation';

describe('parseXpub', () => {
  // BIP84 test vector 1, native segwit, mainnet.
  const ZPUB =
    'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
  // BIP49 test vector, nested segwit, testnet.
  const UPUB =
    'upub5EFU65HtV5TeiSHmZZm7FUffBGy8UKeqp7vw43jYbvZPpoVsgU93oac7Wk3u6moKegAEWtGNF8DehrnHtv21XXEMYRUocHqguyjknFHYfgY';

  it('infers native segwit from a zpub', () => {
    const info = parseXpub(ZPUB);
    expect(info.scriptType).toBe('p2wpkh');
    expect(info.purpose).toBe(84);
    expect(info.chain).toBe('mainnet');
    expect(info.depth).toBe(3);
    expect(info.wasBracketed).toBe(false);
  });

  it('infers nested segwit from an upub and detects testnet', () => {
    const info = parseXpub(UPUB);
    expect(info.scriptType).toBe('p2wpkh-p2sh');
    expect(info.purpose).toBe(49);
    expect(info.chain).toBe('testnet');
  });

  it('normalises a versioned key to the plain BIP32 prefix', () => {
    const info = parseXpub(ZPUB);
    expect(info.xpub.startsWith('xpub')).toBe(true);
    expect(info.xpub).toHaveLength(111);
  });

  it('accepts the Bitcoin Core bracketed form and flags it', () => {
    const info = parseXpub(`[84h/0h/0h]${ZPUB}`);
    expect(info.wasBracketed).toBe(true);
    expect(info.xpub).toBe(parseXpub(ZPUB).xpub);
  });

  it('refuses an extended private key', () => {
    const xprv =
      'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
    expect(() => parseXpub(xprv)).toThrow(/PRIVATE key/i);
  });

  it('rejects a P2WSH key with an explanation instead of a generic error', () => {
    const zpub = 'Zpub75ExXMXDiNU4r1CaL1K92RDEiRTVzMrKVoxBLwYQ1zM8XnJ4o8B3sQdCkNaXwQqZmzszeMVqEb';
    expect(() => parseXpub(zpub)).toThrow(/P2WSH/);
  });

  it('rejects a key whose Base58Check checksum does not hold', () => {
    // Flip the last character to break the checksum.
    const broken = ZPUB.slice(0, -1) + (ZPUB.endsWith('s') ? 't' : 's');
    expect(() => parseXpub(broken)).toThrow(/Base58Check checksum/i);
  });

  it('rejects an empty key', () => {
    expect(() => parseXpub('   ')).toThrow(/empty/i);
  });

  it('rejects an unknown prefix', () => {
    expect(() => parseXpub('qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).toThrow(/Unrecognised/);
  });
});

describe('deriveAddresses against BIP test vectors', () => {
  it('reproduces the BIP84 receive and change addresses', () => {
    const zpub =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    const info = parseXpub(zpub);
    const derived = deriveAddresses(info.xpub, info.scriptType, 3, 'mainnet');

    const recv0 = derived.find((d) => d.chainIndex === 0 && d.index === 0);
    const change0 = derived.find((d) => d.chainIndex === 1 && d.index === 0);

    expect(recv0?.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(change0?.address).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  });

  it('reproduces the BIP49 testnet address', () => {
    const upub =
      'upub5EFU65HtV5TeiSHmZZm7FUffBGy8UKeqp7vw43jYbvZPpoVsgU93oac7Wk3u6moKegAEWtGNF8DehrnHtv21XXEMYRUocHqguyjknFHYfgY';
    const info = parseXpub(upub);
    const derived = deriveAddresses(info.xpub, info.scriptType, 1, 'testnet');
    const recv0 = derived.find((d) => d.chainIndex === 0 && d.index === 0);
    expect(recv0?.address).toBe('2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2');
  });

  it('derives both chains up to the gap limit, with no duplicates', () => {
    const zpub =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    const info = parseXpub(zpub);
    const gap = 5;
    const derived = deriveAddresses(info.xpub, info.scriptType, gap, 'mainnet');

    expect(derived).toHaveLength(gap * 2);
    expect(new Set(derived.map((d) => d.address)).size).toBe(gap * 2);
    expect(derived.filter((d) => d.chainIndex === 0)).toHaveLength(gap);
    expect(derived.filter((d) => d.chainIndex === 1)).toHaveLength(gap);
    expect(derived.every((d) => d.address.startsWith('bc1q'))).toBe(true);
  });

  it('labels each address with its derivation path', () => {
    const zpub =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    const info = parseXpub(zpub);
    const derived = deriveAddresses(info.xpub, info.scriptType, 2, 'mainnet');
    expect(derived.map((d) => d.path).sort()).toEqual(['m/0/0', 'm/0/1', 'm/1/0', 'm/1/1']);
  });

  it('rejects a gap limit outside 1..200', () => {
    const zpub =
      'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    const info = parseXpub(zpub);
    expect(() => deriveAddresses(info.xpub, info.scriptType, 0, 'mainnet')).toThrow(/gapLimit/);
    expect(() => deriveAddresses(info.xpub, info.scriptType, 201, 'mainnet')).toThrow(/gapLimit/);
  });
});

describe('address encoders', () => {
  it('encodes a P2WPKH address from a raw witness program', () => {
    // The genesis coinbase hash160. Its bech32 form is the documented
    // counterpart of 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.
    const hash160 = Uint8Array.from(
      Buffer.from('62e907b15cbf27d5425399ebf6f0fb50ebb88f18', 'hex')
    );
    expect(hash160).toHaveLength(20);
    expect(encodeP2WPKH(hash160, 'mainnet')).toBe(
      'bc1qvt5s0v2uhuna2sjnn84ldu8m2r4m3rcc4048ry'
    );
  });

  it('reproduces the BIP49 nested-segwht address from the published pubkey', () => {
    const pubkey = Uint8Array.from(
      Buffer.from('03a1af804ac108a8a51782198c2d034b28bf90c8803f5a53f76276fa69a4eae77f', 'hex')
    );
    expect(pubkeyToP2WPKHSH(pubkey, 'testnet')).toBe('2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2');
  });

  it('produces distinct P2PKH, P2WPKH-in-P2SH and P2WPKH forms for one key', () => {
    const pubkey = Uint8Array.from(
      Buffer.from('03a1af804ac108a8a51782198c2d034b28bf90c8803f5a53f76276fa69a4eae77f', 'hex')
    );
    const legacy = pubkeyToP2PKH(pubkey, 'mainnet');
    const nested = pubkeyToP2WPKHSH(pubkey, 'mainnet');
    const native = encodeP2WPKH(
      Uint8Array.from(Buffer.from('38971f73930f6c141d977ac4fd4a727c854935b3', 'hex')),
      'mainnet'
    );
    expect(legacy.startsWith('1')).toBe(true);
    expect(nested.startsWith('3')).toBe(true);
    expect(native.startsWith('bc1q')).toBe(true);
    expect(new Set([legacy, nested, native]).size).toBe(3);
  });

  it('encodes a taproot address with the bech32m witness version 1', () => {
    const program = new Uint8Array(32).fill(0x02);
    const address = encodeP2TR(program, 'mainnet');
    expect(address.startsWith('bc1p')).toBe(true);
  });

  it('uses the testnet human-readable part when asked', () => {
    const program = new Uint8Array(20).fill(0x01);
    expect(encodeP2WPKH(program, 'testnet').startsWith('tb1q')).toBe(true);
    expect(encodeP2TR(new Uint8Array(32).fill(0x02), 'testnet').startsWith('tb1p')).toBe(true);
  });
});

describe('classifyAddress', () => {
  it('recognises the three address families', () => {
    expect(classifyAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe('p2pkh');
    expect(classifyAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe('p2sh');
    expect(classifyAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toBe('segwit');
  });

  it('recognises a taproot address as segwit', () => {
    expect(classifyAddress('bc1pqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyvraasj')).toBe('segwit');
  });

  it('rejects things that are not addresses', () => {
    expect(classifyAddress('')).toBe('unknown');
    expect(classifyAddress('not-an-address')).toBe('unknown');
    expect(classifyAddress('0x1234567890abcdef')).toBe('unknown');
    expect(isPlausibleBitcoinAddress('hello')).toBe(false);
  });
});
