-- AlterTable
ALTER TABLE "compliance_certificates" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedReason" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'valid';
