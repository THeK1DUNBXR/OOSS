import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Inbound provider webhooks are signed as HMAC-SHA256 over `<timestamp>.<raw body>`
 * with the endpoint's secret, sent as `X-Kai-Timestamp` and
 * `X-Kai-Signature: sha256=<hex>`. The timestamp sits inside the signed bytes so
 * a captured body cannot be replayed under a fresh timestamp; the tolerance caps
 * how long a captured request stays usable.
 */

/** Only this route needs the unparsed bytes. Other JSON routes keep the default parse. */
export const WEBHOOK_PATH_PREFIX = '/api/marketing/public/webhooks/';

export const WEBHOOK_TOLERANCE_SECONDS = 300;

type RawBodyRequest = IncomingMessage & { originalUrl?: string; rawBody?: Buffer };

/**
 * express.json `verify` hook. It keeps the exact bytes a provider signed, and
 * only for webhook paths. The JSON parse itself is unchanged; a non-JSON
 * webhook body leaves rawBody unset and is refused upstream.
 */
export function captureWebhookRawBody(req: RawBodyRequest, _res: ServerResponse, buf: Buffer): void {
  if (req.originalUrl?.startsWith(WEBHOOK_PATH_PREFIX)) req.rawBody = buf;
}

export function rawBodyOf(req: IncomingMessage): Buffer | undefined {
  return (req as RawBodyRequest).rawBody;
}

export function computeWebhookSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Checks the signature and the freshness window. Compares in constant time, and
 * rejects a length mismatch before timingSafeEqual (which throws on unequal
 * lengths).
 */
export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string;
  rawBody: Buffer;
  signature: string;
  nowSeconds?: number;
}): boolean {
  if (!/^\d{1,12}$/.test(input.timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(input.timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(computeWebhookSignature(input.secret, input.timestamp, input.rawBody));
  const given = Buffer.from(input.signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
