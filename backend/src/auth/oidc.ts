import * as client from 'openid-client';

export interface OidcOptions {
  /** The issuer exactly as configured. Metadata is discovered from it, and must name it back. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Tests only: lets the client talk to a local mock provider over plain HTTP. */
  allowInsecureRequests?: boolean;
}

/** Per-login secrets kept (sealed) in the browser between /auth/login and /auth/callback. */
export interface LoginChecks {
  codeVerifier: string;
  state: string;
  nonce: string;
}

/** The ID token claims the app uses. All of them are validated by openid-client first. */
export interface IdTokenClaims {
  sub: string;
  oid?: unknown;
  name?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  /** The roles claim has the name set in OIDC_ROLES_CLAIM. */
  [claim: string]: unknown;
}

/** The provider can't be used as configured. The message holds no secret or token. */
export class OidcProviderRefused extends Error {
  override name = 'OidcProviderRefused';
}

const scope = 'openid profile email';

type SecretMethod = 'client_secret_post' | 'client_secret_basic';

/**
 * How to send the client secret, from what the provider advertises. An absent list means
 * client_secret_basic (the OIDC Discovery default). Undefined: neither is offered.
 */
function secretMethod(metadata: client.ServerMetadata): SecretMethod | undefined {
  const offered: unknown = metadata.token_endpoint_auth_methods_supported;
  if (offered === undefined) return 'client_secret_basic';
  if (!Array.isArray(offered)) return undefined;
  if (offered.includes('client_secret_post')) return 'client_secret_post';
  return offered.includes('client_secret_basic') ? 'client_secret_basic' : undefined;
}

/** OIDC relying party: authorization code flow with PKCE, state and nonce. */
export class OidcClient {
  #configuration: Promise<client.Configuration> | undefined;

  constructor(private readonly options: OidcOptions) {}

  /** Discovers provider metadata on first use and caches it. A failed discovery is retried next time. */
  #config(): Promise<client.Configuration> {
    this.#configuration ??= this.#discover().catch((error: unknown) => {
      this.#configuration = undefined;
      throw error;
    });
    return this.#configuration;
  }

  async #discover(): Promise<client.Configuration> {
    const post = client.ClientSecretPost(this.options.clientSecret);
    const basic = client.ClientSecretBasic(this.options.clientSecret);
    const config = await client.discovery(
      new URL(this.options.issuer),
      this.options.clientId,
      undefined,
      (as, c, body, headers) => {
        (secretMethod(as) === 'client_secret_post' ? post : basic)(as, c, body, headers);
      },
      {
        execute: [
          // Validate the ID token's signature against the provider's JWKS, not just TLS.
          client.enableNonRepudiationChecks,
          // Tests only (local mock provider); production always requires HTTPS.
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          ...(this.options.allowInsecureRequests ? [client.allowInsecureRequests] : []),
        ],
      },
    );
    const metadata = config.serverMetadata();
    // Exact, and needed on top of the library's own check, which waves through login.microsoftonline.com
    // and *.b2clogin.com addresses and ignores a root path's slash. Entra's /common and /organizations
    // would otherwise take a token from any tenant.
    if (metadata.issuer !== this.options.issuer) {
      throw new OidcProviderRefused(
        `the provider names its issuer as ${metadata.issuer}, which is not exactly OIDC_ISSUER`,
      );
    }
    if (secretMethod(metadata) === undefined) {
      throw new OidcProviderRefused(
        'the provider offers neither client_secret_post nor client_secret_basic',
      );
    }
    return config;
  }

  async startLogin(): Promise<{ url: URL; checks: LoginChecks }> {
    const config = await this.#config();
    const checks: LoginChecks = {
      codeVerifier: client.randomPKCECodeVerifier(),
      state: client.randomState(),
      nonce: client.randomNonce(),
    };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.options.redirectUri,
      response_type: 'code',
      // Query mode: the callback is a top-level GET, so the SameSite=Lax login cookie is sent.
      response_mode: 'query',
      scope,
      code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
      code_challenge_method: 'S256',
      state: checks.state,
      nonce: checks.nonce,
    });
    return { url, checks };
  }

  /**
   * Exchanges the code and validates the ID token (issuer, audience, signature, expiry, nonce)
   * and the state. Throws on any mismatch. Tokens are not returned: the app keeps none.
   */
  async finishLogin(callbackSearch: string, checks: LoginChecks): Promise<IdTokenClaims> {
    const config = await this.#config();
    // Build the URL from configuration, never from the request's Host header.
    const currentUrl = new URL(this.options.redirectUri);
    currentUrl.search = callbackSearch;
    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('ID token missing');
    return claims;
  }

  /**
   * The provider's end-session URL, or null if it has none. No ID token hint: it would put a token
   * in the browser's address bar. No return address: the provider shows its own signed-out page,
   * so nothing more is registered there.
   */
  async logoutUrl(): Promise<URL | null> {
    const config = await this.#config();
    if (config.serverMetadata().end_session_endpoint === undefined) return null;
    return client.buildEndSessionUrl(config, {
      client_id: this.options.clientId,
    });
  }
}
