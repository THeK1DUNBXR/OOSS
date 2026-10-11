-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "abandonedAt" TIMESTAMP(3),
ADD COLUMN     "abandonedRefreshTokenHash" TEXT;
