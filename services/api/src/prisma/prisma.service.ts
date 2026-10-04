import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createLogger } from '@krypton/logger';

const logger = createLogger({ serviceName: 'prisma-service' });

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    try {
      await this.$connect();
      logger.info('Prisma connected to PostgreSQL successfully');
    } catch (err) {
      logger.error({ err }, 'Failed to connect to PostgreSQL via Prisma');
      throw err;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    logger.info('Prisma disconnected from PostgreSQL');
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
