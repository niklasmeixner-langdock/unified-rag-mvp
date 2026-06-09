// Microsoft identity platform OAuth 2.0 authorization code flow.
// Reference: https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow

import { env } from '../../env.js';

const MS_AUTHORIZE_BASE = (tenantId: string) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL = (tenantId: string) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  scope: string;
  token_type: string;
}

export function buildAuthorizeUrl(input: {
  scope: string;
  redirectUrl: string;
  state: string;
}): string {
  const base = MS_AUTHORIZE_BASE(env.MS_TENANT_ID);
  const params = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    response_type: 'code',
    scope: input.scope,
    redirect_uri: input.redirectUrl,
    state: input.state,
    response_mode: 'query',
    prompt: 'select_account',
  });
  // `offline_access` in the scope set issues refresh tokens; access_type=offline kept for parity with v1 endpoints.
  return `${base}?${params.toString()}&access_type=offline`;
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  redirectUrl: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    code: input.code,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUrl,
  });
  return postToken(body);
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return postToken(body);
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(MS_TOKEN_URL(env.MS_TENANT_ID), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Microsoft token endpoint failed (${res.status}): ${errBody}`);
  }
  return (await res.json()) as TokenResponse;
}
