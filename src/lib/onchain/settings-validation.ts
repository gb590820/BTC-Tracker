/**
 * Validation of the on-chain settings block.
 *
 * The endpoint is the one setting here that is genuinely dangerous to get wrong:
 * it is a URL the server will call on a schedule, with whatever addresses the
 * user has added, and a typo that resolves to some other host would leak the
 * whole watch list there. So it is checked for shape and scheme here, once,
 * wherever the settings are written.
 */

import { OnchainSettings } from '@/lib/types';
import { MAX_GAP_LIMIT } from '@/lib/onchain/address-derivation';

/** Smallest sensible poll interval: below this a self-hoster rate-limits itself. */
export const MIN_SYNC_INTERVAL_MINUTES = 1;
export const MAX_SYNC_INTERVAL_MINUTES = 24 * 60;

export const MIN_REQUEST_TIMEOUT_MS = 1000;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;

export class OnchainSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnchainSettingsError';
    // tsconfig targets ES5, where extending a built-in is emulated by copying the
    // prototype chain. Without this the instance's prototype is still `Error`, so
    // `instanceof OnchainSettingsError` is false and the settings route would
    // report a bad endpoint as a server error instead of a 400.
    Object.setPrototypeOf(this, OnchainSettingsError.prototype);
  }
}

/**
 * Normalise and check an on-chain settings patch.
 *
 * Unknown keys are dropped rather than rejected, so a client built against a
 * newer version does not fail on a field this one does not know. Returns the
 * merged block ready to be persisted.
 */
export function validateOnchainSettings(
  input: unknown,
  current: OnchainSettings
): OnchainSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new OnchainSettingsError('onchain settings must be an object');
  }

  const patch = input as Record<string, unknown>;
  const next: OnchainSettings = { ...current };

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      throw new OnchainSettingsError('onchain.enabled must be true or false');
    }
    next.enabled = patch.enabled;
  }

  if (patch.recalculatePortfolio !== undefined) {
    if (typeof patch.recalculatePortfolio !== 'boolean') {
      throw new OnchainSettingsError('onchain.recalculatePortfolio must be true or false');
    }
    next.recalculatePortfolio = patch.recalculatePortfolio;
  }

  if (patch.esploraEndpoint !== undefined) {
    next.esploraEndpoint = normaliseEndpoint(patch.esploraEndpoint);
  }

  if (patch.syncIntervalMinutes !== undefined) {
    next.syncIntervalMinutes = integerInRange(
      patch.syncIntervalMinutes,
      'onchain.syncIntervalMinutes',
      MIN_SYNC_INTERVAL_MINUTES,
      MAX_SYNC_INTERVAL_MINUTES
    );
  }

  if (patch.gapLimit !== undefined) {
    next.gapLimit = integerInRange(
      patch.gapLimit,
      'onchain.gapLimit',
      1,
      MAX_GAP_LIMIT
    );
  }

  if (patch.requestTimeoutMs !== undefined) {
    next.requestTimeoutMs = integerInRange(
      patch.requestTimeoutMs,
      'onchain.requestTimeoutMs',
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS
    );
  }

  return next;
}

/**
 * Accept the endpoint in the shapes people actually type and store one canonical
 * form: no trailing slash, no query, no fragment, http or https only.
 */
export function normaliseEndpoint(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new OnchainSettingsError('onchain.esploraEndpoint must be a URL');
  }

  const trimmed = raw.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new OnchainSettingsError(
      'onchain.esploraEndpoint must be a valid URL, for example https://mempool.space/api'
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // A file:, data: or gopher: URL here would be a way to make the server read
    // something local on every tick.
    throw new OnchainSettingsError('onchain.esploraEndpoint must be an http or https URL');
  }

  if (!parsed.hostname) {
    throw new OnchainSettingsError('onchain.esploraEndpoint must include a host');
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

function integerInRange(raw: unknown, name: string, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw);

  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new OnchainSettingsError(`${name} must be a whole number`);
  }

  if (value < min || value > max) {
    throw new OnchainSettingsError(`${name} must be between ${min} and ${max}`);
  }

  return value;
}
