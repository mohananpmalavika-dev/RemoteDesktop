-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "policy" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "mfa_verified" BOOLEAN NOT NULL DEFAULT false;
