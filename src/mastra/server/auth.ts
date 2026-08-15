import { createHash, timingSafeEqual } from 'node:crypto';
import type { Middleware } from '@mastra/core/server';

/**
 * Vercel's Deployment Protection only covers preview deployments on the Hobby
 * plan, so a production deployment is publicly reachable. Without a gate here,
 * anyone holding the URL can drive the agents — which means writing rows to
 * Supabase through the service-role key and spending Gateway credits.
 */

const TOKEN_HEADER = 'x-mastra-api-key';

/**
 * Compare digests rather than the raw strings: timingSafeEqual requires equal
 * lengths, and hashing first means a wrong token leaks neither its content
 * (through timing) nor its length (through an early return).
 */
const matches = (candidate: string, expected: string) =>
  timingSafeEqual(
    createHash('sha256').update(candidate).digest(),
    createHash('sha256').update(expected).digest(),
  );

/**
 * Enforce on deployments only. Vercel sets VERCEL on every deployment, so local
 * `mastra dev` and Studio keep working without a token — a browser cannot
 * attach a custom header, so enforcing locally would lock you out of Studio.
 */
const isDeployed = () => Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';

export const apiKeyAuth: Middleware = {
  path: '*',
  handler: async (c, next) => {
    if (!isDeployed()) return next();

    const expected = process.env.MASTRA_API_TOKEN;

    // Fail closed. A deployment that forgot the token is a misconfiguration,
    // and treating it as "no auth required" would silently publish the agents.
    if (!expected) {
      return c.json({ error: 'Server is missing MASTRA_API_TOKEN.' }, 503);
    }

    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const presented = c.req.header(TOKEN_HEADER) ?? bearer ?? '';

    if (!matches(presented, expected)) {
      return c.json({ error: 'Unauthorized.' }, 401);
    }

    return next();
  },
};
