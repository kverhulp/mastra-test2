/**
 * True when running on a deployment rather than a developer's machine.
 *
 * Vercel sets VERCEL on every deployment. Used to decide what may only exist
 * locally: the API gate is enforced only when deployed, and the code-backed
 * Agent Editor is registered only when not.
 */
export const isDeployed = () =>
  Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';
