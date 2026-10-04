import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  getLive() {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async getReady() {
    const isDbHealthy = await this.prisma.isHealthy();
    const isRedisHealthy = await this.redis.isHealthy();

    const allHealthy = isDbHealthy && isRedisHealthy;

    const result = {
      status: allHealthy ? 'UP' : 'DOWN',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: isDbHealthy ? 'HEALTHY' : 'UNHEALTHY',
        redis: isRedisHealthy ? 'HEALTHY' : 'UNHEALTHY',
      },
    };

    if (!allHealthy) {
      throw new HttpException(
        {
          code: 'DEPENDENCY_UNHEALTHY',
          message: 'One or more required infrastructure dependencies are unavailable.',
          details: result,
          retryable: true,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return result;
  }
}
