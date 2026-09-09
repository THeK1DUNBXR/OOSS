/**
 * The Cloudflare Worker.
 *
 * It serves the built client and forwards `/api` to wherever the API actually
 * runs. That split is not a shortcut — it is the only honest shape available,
 * and it is worth saying why in the file rather than in a commit message
 * somebody has to go looking for.
 *
 * The API is Express 4 on Prisma against PostgreSQL, with a job scheduler
 * holding a `setInterval` and request context in an `AsyncLocalStorage`. None
 * of that runs on Workers as written:
 *
 *   - Prisma reaches PostgreSQL over TCP. On Workers that needs a driver
 *     adapter plus a Hyperdrive binding, and a Hyperdrive binding is created
 *     against a specific database in a specific Cloudflare account.
 *   - The scheduler is a long-lived interval. Workers have no long-lived
 *     process; the equivalent is a Cron Trigger or a Durable Object.
 *   - Express middleware is built on Node's stream-based req/res, not on
 *     `fetch`.
 *
 * A port is possible and is a real piece of work. What is not acceptable is a
 * Worker that deploys green and then fails on every request, so this one does
 * the part that genuinely runs at the edge — the client — and is explicit about
 * the part that does not.
 *
 * Set `API_ORIGIN` to the URL of the running API and the whole app works
 * through this Worker. Leave it unset and every API call returns a 503 that
 * says so in words, which the client already renders, because a blank screen
 * that could mean anything is worse than an error that means one thing.
 */

interface Env {
  ASSETS: Fetcher;
  /** Origin of the running API, e.g. `https://api.example.com`. No trailing slash. */
  API_ORIGIN?: string;
}

/** Paths the API owns. Everything else is the client. */
const API_PREFIXES = ['/api/', '/health'];

const isApiPath = (pathname: string): boolean =>
  API_PREFIXES.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!isApiPath(url.pathname)) {
      // `not_found_handling: single-page-application` in wrangler.jsonc means a
      // deep link like /people/employees returns index.html rather than a 404,
      // so the router can take it from there.
      return env.ASSETS.fetch(request);
    }

    const origin = env.API_ORIGIN?.replace(/\/+$/, '');
    if (!origin) {
      return json(503, {
        error: {
          code: 'API_ORIGIN_NOT_CONFIGURED',
          message:
            'This Worker serves the client but has no API to talk to yet. Set the API_ORIGIN variable ' +
            'on the “ooss” Worker to the URL of the running API — the API is Express on PostgreSQL and ' +
            'runs on a Node host, not on Workers.',
        },
      });
    }

    const target = new URL(url.pathname + url.search, origin);

    // The body is forwarded as a stream rather than buffered: an import upload
    // is a spreadsheet posted as a raw body, and reading it into memory here
    // would put the Worker's memory limit between the user and their own file.
    const upstream = new Request(target, {
      method: request.method,
      headers: stripHopByHop(request.headers),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      // Required by the runtime whenever a streaming body is forwarded.
      ...(request.body ? { duplex: 'half' } : {}),
    } as RequestInit);

    try {
      const response = await fetch(upstream);
      // Cloned so the headers are mutable; the body is passed through untouched.
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: stripHopByHop(response.headers),
      });
    } catch (error) {
      return json(502, {
        error: {
          code: 'API_UNREACHABLE',
          message: `The API at ${origin} could not be reached: ${(error as Error).message}`,
        },
      });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Headers that describe one hop and must not be copied to the next.
 *
 * `host` is the one that actually bites: forwarding the Worker's host to the
 * API sends it a name it does not serve, and the failure looks like a routing
 * problem rather than a header problem.
 */
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

function stripHopByHop(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.append(key, value);
  }
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
