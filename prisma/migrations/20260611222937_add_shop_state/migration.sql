-- CreateTable
CREATE TABLE "ShopState" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "reviewAskedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopState_shop_key" ON "ShopState"("shop");
