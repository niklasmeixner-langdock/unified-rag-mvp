// Shared OAuth token access for everything that talks to Graph (workers, MCP tools).

import { prisma } from '../../db/client.js';
import { redis } from '../../queues/connection.js';
import { refreshAccessToken } from './oauth.js';

const TOKEN_EXPIRY_SLACK_MS = 5 * 60_000;

// Microsoft refresh tokens are single-use: concurrent refreshes from multiple
// processes invalidate each other and kill the source's credentials.
// Serialize via a Redis lock and re-read the row inside it; losers of the
// race pick up the winner's freshly stored token instead of refreshing again.
export async function getFreshAccessToken(tokenId: string): Promise<string> {
  let token = await prisma.oAuthToken.findUniqueOrThrow({ where: { id: tokenId } });
  if (token.expiresAt.getTime() - Date.now() > TOKEN_EXPIRY_SLACK_MS) return token.accessToken;

  const lockKey = `oauth-refresh:${tokenId}`;
  const deadline = Date.now() + 60_000;
  while (true) {
    const acquired = await redis.set(lockKey, '1', 'PX', 30_000, 'NX');
    if (acquired) {
      try {
        token = await prisma.oAuthToken.findUniqueOrThrow({ where: { id: tokenId } });
        if (token.expiresAt.getTime() - Date.now() > TOKEN_EXPIRY_SLACK_MS) {
          return token.accessToken;
        }
        // TODO: encrypt tokens at rest before any non-local deployment.
        const refreshed = await refreshAccessToken(token.refreshToken);
        await prisma.oAuthToken.update({
          where: { id: tokenId },
          data: {
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token ?? token.refreshToken,
            expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
          },
        });
        return refreshed.access_token;
      } finally {
        await redis.del(lockKey);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for OAuth refresh lock on token ${tokenId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// MVP convenience: single-tenant service, so "the connection" is simply the
// most recent OAuth grant. Spares MCP clients from copying token IDs around.
export async function getLatestTokenId(): Promise<string> {
  const token = await prisma.oAuthToken.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!token) {
    throw new Error(
      'No Microsoft connection yet. Open /oauth/start in a browser and consent first.',
    );
  }
  return token.id;
}
