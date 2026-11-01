// Resolve the options for "bteam serve" from command-line values and the environment.
// The bind address defaults to loopback. A container image sets BTEAM_HOST=0.0.0.0 so the
// reverse proxy can reach it over the container network; nothing else changes the default.
// Kept free of the server module so the container health check starts fast.
// Must match isLoopback() in server.js (a test checks this).
export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8080;

export class ServeOptionsError extends Error {}

/**
 * @param {object} values  parsed CLI values (host, port, dev-user)
 * @param {object} [env]   environment (BTEAM_HOST, PORT)
 * @returns {{host: string, port: number, devUser: string|null, public: boolean}}
 */
export function resolveServeOptions(values = {}, env = process.env) {
  const rawHost = values.host ?? (env.BTEAM_HOST || undefined) ?? DEFAULT_HOST;
  const host = String(rawHost).trim();
  if (!host || host.length > 253 || !/^[A-Za-z0-9.:-]+$/.test(host)) throw new ServeOptionsError(`invalid bind address "${rawHost}"`);

  const rawPort = values.port ?? (env.PORT || undefined) ?? DEFAULT_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(rawPort).trim() === '') throw new ServeOptionsError(`invalid port "${rawPort}"`);

  const devUser = values['dev-user'] ?? null;
  if (devUser && !isLoopback(host)) throw new ServeOptionsError('--dev-user is only allowed with a loopback --host (127.0.0.1 or ::1)');

  return { host, port, devUser, public: !isLoopback(host) };
}

/** URL the container health check calls: loopback for wildcard or loopback binds, else the bind address. */
export function healthUrl(env = process.env) {
  const { host, port } = resolveServeOptions({}, env);
  const target = host === '0.0.0.0' || host === '::' || isLoopback(host) ? '127.0.0.1' : host;
  return `http://${target.includes(':') ? `[${target}]` : target}:${port}/healthz`;
}

/** True if the health endpoint answers 200 (the source has been mirrored) within the timeout. */
export async function checkHealth(url, { timeoutMs = 4000, fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  }
}
