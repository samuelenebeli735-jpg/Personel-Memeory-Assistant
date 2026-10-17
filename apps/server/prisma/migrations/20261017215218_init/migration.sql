-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "displayName" TEXT,
    "timeZone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "morningDefaultTime" TEXT NOT NULL DEFAULT '09:00',
    "eveningDefaultTime" TEXT NOT NULL DEFAULT '19:00',
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "maxNotificationsPerDay" INTEGER NOT NULL DEFAULT 0,
    "briefingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "briefingTime" TEXT NOT NULL DEFAULT '07:30',
    "briefingSections" TEXT NOT NULL DEFAULT '["today","overdue","upcoming"]',
    "reminderOverdueGraceHours" INTEGER NOT NULL DEFAULT 12,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "captures" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "dedupeHash" TEXT,
    "rawText" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "confidence" REAL NOT NULL DEFAULT 0,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "classificationRationale" TEXT,
    "metadata" TEXT,
    "transcript" TEXT,
    "transcriptSource" TEXT,
    "mediaRef" TEXT,
    "sourceRef" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" TEXT,
    "category" TEXT,
    "dueAt" DATETIME,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "projectId" TEXT,
    "captureId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "tasks_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "captures" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "projectId" TEXT,
    "captureId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "notes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "notes_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "captures" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ideas" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "projectId" TEXT,
    "captureId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ideas_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ideas_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "captures" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME,
    "projectId" TEXT,
    "captureId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "events_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "captures" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "capture_tags" (
    "captureId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("captureId", "tagId"),
    CONSTRAINT "capture_tags_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "captures" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "capture_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "task_tags" (
    "taskId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("taskId", "tagId"),
    CONSTRAINT "task_tags_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "note_tags" (
    "noteId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("noteId", "tagId"),
    CONSTRAINT "note_tags_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "note_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "idea_tags" (
    "ideaId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("ideaId", "tagId"),
    CONSTRAINT "idea_tags_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ideas" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "idea_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "capture_relations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromCaptureId" TEXT NOT NULL,
    "toCaptureId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "capture_relations_fromCaptureId_fkey" FOREIGN KEY ("fromCaptureId") REFERENCES "captures" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "capture_relations_toCaptureId_fkey" FOREIGN KEY ("toCaptureId") REFERENCES "captures" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "remindAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deliveredAt" DATETIME,
    "taskId" TEXT,
    "captureId" TEXT,
    "recurrence" TEXT,
    "parentId" TEXT,
    "occurrenceKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "reminders_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "reminders_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "captures" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "reminders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "reminders" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "reminder_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reminderId" TEXT NOT NULL,
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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "reminder_deliveries_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "reminders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "captures_status_createdAt_idx" ON "captures"("status", "createdAt");

-- CreateIndex
CREATE INDEX "captures_kind_createdAt_idx" ON "captures"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "captures_capturedAt_idx" ON "captures"("capturedAt");

-- CreateIndex
CREATE INDEX "captures_dedupeHash_idx" ON "captures"("dedupeHash");

-- CreateIndex
CREATE UNIQUE INDEX "captures_source_externalId_key" ON "captures"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_name_key" ON "projects"("name");

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE INDEX "tasks_status_dueAt_idx" ON "tasks"("status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_dueAt_idx" ON "tasks"("dueAt");

-- CreateIndex
CREATE INDEX "tasks_projectId_idx" ON "tasks"("projectId");

-- CreateIndex
CREATE INDEX "tasks_captureId_idx" ON "tasks"("captureId");

-- CreateIndex
CREATE INDEX "notes_projectId_idx" ON "notes"("projectId");

-- CreateIndex
CREATE INDEX "notes_captureId_idx" ON "notes"("captureId");

-- CreateIndex
CREATE INDEX "notes_createdAt_idx" ON "notes"("createdAt");

-- CreateIndex
CREATE INDEX "ideas_projectId_idx" ON "ideas"("projectId");

-- CreateIndex
CREATE INDEX "ideas_captureId_idx" ON "ideas"("captureId");

-- CreateIndex
CREATE INDEX "ideas_createdAt_idx" ON "ideas"("createdAt");

-- CreateIndex
CREATE INDEX "events_startsAt_idx" ON "events"("startsAt");

-- CreateIndex
CREATE INDEX "events_projectId_idx" ON "events"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "capture_tags_tagId_idx" ON "capture_tags"("tagId");

-- CreateIndex
CREATE INDEX "task_tags_tagId_idx" ON "task_tags"("tagId");

-- CreateIndex
CREATE INDEX "note_tags_tagId_idx" ON "note_tags"("tagId");

-- CreateIndex
CREATE INDEX "idea_tags_tagId_idx" ON "idea_tags"("tagId");

-- CreateIndex
CREATE INDEX "capture_relations_toCaptureId_idx" ON "capture_relations"("toCaptureId");

-- CreateIndex
CREATE UNIQUE INDEX "capture_relations_fromCaptureId_toCaptureId_relationType_key" ON "capture_relations"("fromCaptureId", "toCaptureId", "relationType");

-- CreateIndex
CREATE INDEX "reminders_status_remindAt_idx" ON "reminders"("status", "remindAt");

-- CreateIndex
CREATE INDEX "reminders_remindAt_idx" ON "reminders"("remindAt");

-- CreateIndex
CREATE INDEX "reminders_taskId_idx" ON "reminders"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_occurrenceKey_key" ON "reminders"("occurrenceKey");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_deliveries_idempotencyKey_key" ON "reminder_deliveries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "reminder_deliveries_status_nextRetryAt_idx" ON "reminder_deliveries"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "reminder_deliveries_reminderId_idx" ON "reminder_deliveries"("reminderId");
