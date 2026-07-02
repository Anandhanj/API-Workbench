export { AuthService, type AuthSource } from './auth-service';
export { applyAuth, AuthError } from './applier';
export { resolveInheritedAuth, type InheritanceLookups } from './inheritance';
export { signSigV4, type SigV4Input, type SigV4Output } from './aws-sigv4';
export { parseChallenge, buildDigestHeader, type DigestChallenge } from './digest';
export {
  refreshOAuth2,
  isOAuth2Expired,
  type TokenFetcher,
  type TokenResponse,
} from './token-manager';
