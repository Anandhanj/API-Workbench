import type { AuthArtifacts, AuthConfig, ApplyContext } from '@shared/auth';
import { signSigV4 } from './aws-sigv4';
import { buildDigestHeader, parseChallenge } from './digest';

/** Raised when a config cannot be applied (e.g. digest without a challenge). */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function empty(): AuthArtifacts {
  return { headers: {}, query: {}, cookies: {} };
}

/**
 * Turns a (variable-resolved) {@link AuthConfig} into concrete HTTP artifacts —
 * headers, query params, cookies, and TLS material — for the execution engine.
 * Pure and synchronous: OAuth2 token refresh happens upstream so the access
 * token here is already current.
 */
export function applyAuth(config: AuthConfig, ctx: ApplyContext): AuthArtifacts {
  const out = empty();
  switch (config.type) {
    // `inherit` is resolved away before execution (see auth/inheritance.ts); if a
    // stray one reaches here (e.g. a workflow node), treat it as no auth like `none`.
    case 'none':
    case 'inherit':
      return out;

    case 'bearer':
      out.headers['Authorization'] = `Bearer ${config.token}`;
      return out;

    case 'basic':
      out.headers['Authorization'] =
        'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
      return out;

    case 'apiKey':
      if (config.in === 'query') out.query[config.key] = config.value;
      else out.headers[config.key] = config.value;
      return out;

    case 'oauth2':
      out.headers['Authorization'] = `${config.headerPrefix} ${config.accessToken}`.trim();
      return out;

    case 'cookie':
      for (const { name, value } of config.cookies) out.cookies[name] = value;
      return out;

    case 'clientCert':
      out.tls = {
        certPem: config.certPem,
        keyPem: config.keyPem,
        ...(config.passphrase ? { passphrase: config.passphrase } : {}),
      };
      return out;

    case 'digest': {
      if (!ctx.method) {
        throw new AuthError('Digest authentication requires an HTTP request context');
      }
      if (!ctx.digestChallenge) {
        throw new AuthError('Digest authentication requires a challenge from a prior 401 response');
      }
      const uri = new URL(ctx.url).pathname + new URL(ctx.url).search;
      out.headers['Authorization'] = buildDigestHeader({
        username: config.username,
        password: config.password,
        method: ctx.method,
        uri,
        challenge: { ...parseChallenge(ctx.digestChallenge), algorithm: config.algorithm },
      });
      return out;
    }

    case 'awsSigv4': {
      if (!ctx.method) {
        throw new AuthError('AWS SigV4 signing requires an HTTP request context');
      }
      const signed = signSigV4({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region,
        service: config.service,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
        method: ctx.method,
        url: ctx.url,
        ...(ctx.headers ? { headers: ctx.headers } : {}),
        ...(ctx.body !== undefined ? { body: ctx.body } : {}),
        ...(ctx.now !== undefined ? { now: ctx.now } : {}),
      });
      Object.assign(out.headers, signed.headers);
      return out;
    }

    default:
      return out;
  }
}
