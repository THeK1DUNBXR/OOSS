-- Phase 0.2 session hardening, scoped to what the refresh-token/httpOnly
-- cookie flow needs: a revocable session behind each access token's `jti`.

CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sessions_jti_key" ON "sessions"("jti");

CREATE INDEX "sessions_tenantId_userId_idx" ON "sessions"("tenantId", "userId");

CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
