-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('SHAREPOINT', 'ONEDRIVE');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('IDLE', 'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "Source" (
    "id" UUID NOT NULL,
    "connectorType" "ConnectorType" NOT NULL,
    "label" TEXT NOT NULL,
    "externalRef" JSONB NOT NULL,
    "deltaCursor" TEXT,
    "oauthTokenId" UUID,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'IDLE',
    "syncMessage" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "contentHash" TEXT,
    "contentVersion" TEXT,
    "vectorIds" TEXT[],
    "extractedAt" TIMESTAMP(3),
    "embeddedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "documentsScanned" INTEGER NOT NULL DEFAULT 0,
    "documentsChanged" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Source_connectorType_syncStatus_idx" ON "Source"("connectorType", "syncStatus");

-- CreateIndex
CREATE INDEX "Document_sourceId_embeddedAt_idx" ON "Document"("sourceId", "embeddedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Document_sourceId_externalId_key" ON "Document"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "SyncRun_sourceId_startedAt_idx" ON "SyncRun"("sourceId", "startedAt");

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_oauthTokenId_fkey" FOREIGN KEY ("oauthTokenId") REFERENCES "OAuthToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

