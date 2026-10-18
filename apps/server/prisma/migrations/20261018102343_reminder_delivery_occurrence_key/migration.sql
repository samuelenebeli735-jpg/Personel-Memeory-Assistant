-- DropIndex
DROP INDEX "reminder_deliveries_reminderId_idx";

-- AlterTable
ALTER TABLE "reminder_deliveries" ADD COLUMN "occurrenceKey" TEXT;

-- CreateIndex
CREATE INDEX "reminder_deliveries_reminderId_occurrenceKey_idx" ON "reminder_deliveries"("reminderId", "occurrenceKey");

-- CreateIndex
CREATE INDEX "reminder_deliveries_deliveredAt_idx" ON "reminder_deliveries"("deliveredAt");

-- CreateIndex
CREATE INDEX "reminders_parentId_idx" ON "reminders"("parentId");
