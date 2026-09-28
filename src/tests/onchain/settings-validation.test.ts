/**
 * On-chain settings validation tests.
 *
 * The endpoint is the setting with teeth: it is fetched on a schedule, with the
 * user's watch list in the URL path. These cases pin down what is refused before
 * anything is persisted, since `SettingsService.updateSettings` calls this on
 * every write path.
 */

import {
  validateOnchainSettings,
  normaliseEndpoint,
  OnchainSettingsError,
  MIN_SYNC_INTERVAL_MINUTES,
  MAX_REQUEST_TIMEOUT_MS,
} from '@/lib/onchain/settings-validation';
import { defaultSettings } from '@/lib/types';

const current = defaultSettings.onchain;

function expectRejected(run: () => unknown, pattern: RegExp) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OnchainSettingsError);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error('expected the value to be rejected');
}

describe('validateOnchainSettings', () => {
  it('keeps untouched values', () => {
    const next = validateOnchainSettings({ enabled: true }, current);
    expect(next.enabled).toBe(true);
    expect(next.esploraEndpoint).toBe(current.esploraEndpoint);
    expect(next.gapLimit).toBe(current.gapLimit);
    expect(next.requestTimeoutMs).toBe(current.requestTimeoutMs);
  });

  it('merges a partial patch onto the current block', () => {
    const next = validateOnchainSettings({ gapLimit: 40, recalculatePortfolio: false }, current);
    expect(next.gapLimit).toBe(40);
    expect(next.recalculatePortfolio).toBe(false);
    expect(next.enabled).toBe(current.enabled);
  });

  it('ignores unknown keys so a newer client does not fail', () => {
    const next = validateOnchainSettings({ somethingFromTheFuture: true }, current);
    expect(next).toEqual(current);
  });

  it('rejects a non-object', () => {
    expectRejected(() => validateOnchainSettings('yes', current), /must be an object/);
    expectRejected(() => validateOnchainSettings([1, 2], current), /must be an object/);
  });

  describe('the endpoint', () => {
    it('accepts a normal esplora URL', () => {
      const next = validateOnchainSettings(
        { esploraEndpoint: 'https://electrs.mynode.local:3000/api' },
        current
      );
      expect(next.esploraEndpoint).toBe('https://electrs.mynode.local:3000/api');
    });

    it('strips a trailing slash so paths do not double up', () => {
      expect(normaliseEndpoint('https://mempool.space/api/')).toBe('https://mempool.space/api');
      expect(normaliseEndpoint('  https://mempool.space/api//  ')).toBe('https://mempool.space/api');
    });

    it('drops a query string and a fragment', () => {
      expect(normaliseEndpoint('https://host/api?token=x#frag')).toBe('https://host/api');
    });

    it('accepts a self-hosted http endpoint', () => {
      expect(normaliseEndpoint('http://192.168.1.10:3000/api')).toBe('http://192.168.1.10:3000/api');
    });

    it('refuses a scheme that would read something local', () => {
      expectRejected(() => normaliseEndpoint('file:///etc/passwd'), /http or https/);
      expectRejected(() => normaliseEndpoint('data:text/plain,hello'), /http or https/);
      expectRejected(() => normaliseEndpoint('gopher://host/'), /http or https/);
    });

    it('refuses something that is not a URL at all', () => {
      expectRejected(() => normaliseEndpoint('mempool.space'), /valid URL/);
      expectRejected(() => normaliseEndpoint(''), /must be a URL/);
      expectRejected(() => normaliseEndpoint(42), /must be a URL/);
    });
  });

  describe('numeric ranges', () => {
    it('refuses an interval that would hammer the backend', () => {
      expectRejected(
        () => validateOnchainSettings({ syncIntervalMinutes: 0 }, current),
        /syncIntervalMinutes/
      );
      expectRejected(
        () => validateOnchainSettings({ syncIntervalMinutes: 1.5 }, current),
        /whole number/
      );
    });

    it('accepts the interval bounds', () => {
      expect(
        validateOnchainSettings({ syncIntervalMinutes: MIN_SYNC_INTERVAL_MINUTES }, current)
          .syncIntervalMinutes
      ).toBe(MIN_SYNC_INTERVAL_MINUTES);
    });

    it('refuses a gap limit beyond what the derivation will do', () => {
      expectRejected(() => validateOnchainSettings({ gapLimit: 0 }, current), /gapLimit/);
      expectRejected(() => validateOnchainSettings({ gapLimit: 100000 }, current), /gapLimit/);
    });

    it('refuses a timeout that is too small to be useful or too large to be safe', () => {
      expectRejected(() => validateOnchainSettings({ requestTimeoutMs: 10 }, current), /requestTimeoutMs/);
      expectRejected(
        () => validateOnchainSettings({ requestTimeoutMs: MAX_REQUEST_TIMEOUT_MS + 1 }, current),
        /requestTimeoutMs/
      );
    });
  });

  describe('booleans', () => {
    it('refuses a stringly typed flag', () => {
      expectRejected(() => validateOnchainSettings({ enabled: 'true' }, current), /true or false/);
      expectRejected(
        () => validateOnchainSettings({ recalculatePortfolio: 1 }, current),
        /true or false/
      );
    });

    it('accepts real booleans', () => {
      expect(validateOnchainSettings({ enabled: false }, current).enabled).toBe(false);
      expect(validateOnchainSettings({ recalculatePortfolio: true }, current).recalculatePortfolio).toBe(
        true
      );
    });
  });
});
