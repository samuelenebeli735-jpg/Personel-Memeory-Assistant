-- CreateTable
CREATE TABLE "briefing_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "occurrenceKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "channel" TEXT NOT NULL DEFAULT 'telegram',
    "scheduledFor" DATETIME NOT NULL,
    "attemptedAt" DATETIME,
    "deliveredAt" DATETIME,
    "nextRetryAt" DATETIME,
    "error" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "briefing_deliveries_idempotencyKey_key" ON "briefing_deliveries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "briefing_deliveries_status_nextRetryAt_idx" ON "briefing_deliveries"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "briefing_deliveries_occurrenceKey_idx" ON "briefing_deliveries"("occurrenceKey");

-- CreateIndex
CREATE INDEX "briefing_deliveries_deliveredAt_idx" ON "briefing_deliveries"("deliveredAt");
