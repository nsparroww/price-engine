-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "competitorUrl" TEXT NOT NULL,
    "competitorHost" TEXT,
    "confidence" REAL NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'auto',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchId" TEXT NOT NULL,
    "price" REAL,
    "currency" TEXT,
    "inStock" BOOLEAN,
    "via" TEXT,
    "scrapedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Observation_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Match_shop_idx" ON "Match"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Match_shop_productGid_competitorUrl_key" ON "Match"("shop", "productGid", "competitorUrl");

-- CreateIndex
CREATE INDEX "Observation_matchId_scrapedAt_idx" ON "Observation"("matchId", "scrapedAt");
