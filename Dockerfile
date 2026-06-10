FROM node:20-alpine AS builder
WORKDIR /app

# openssl: required by Prisma's query engine on Alpine (avoids libssl detection failure)
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json ./
COPY src ./src
RUN pnpm prisma generate
RUN pnpm build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# openssl: required by Prisma's query engine on Alpine (avoids libssl detection failure)
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
RUN pnpm prisma generate

COPY --from=builder /app/dist ./dist

EXPOSE 3000

# Default command runs the API server. Override to `node dist/queues/worker.js`
# for the worker service in Railway.
CMD ["node", "dist/server.js"]
