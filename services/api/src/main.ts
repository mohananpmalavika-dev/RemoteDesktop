import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getConfig } from '@krypton/config';
import { createLogger } from '@krypton/logger';
import { KryptonExceptionFilter } from './common/filters/http-exception.filter';

const logger = createLogger({ serviceName: 'krypton-api-bootstrap' });

async function bootstrap() {
  // Fail-fast configuration loading
  const config = getConfig();

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Global error filter adhering to Section 38 standardized format
  app.useGlobalFilters(new KryptonExceptionFilter());

  // Global route prefix
  app.setGlobalPrefix('api/v1');

  // Security Headers (Section 41)
  app.use((_req: any, res: any, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Strict CORS in production (Section 41)
  if (config.NODE_ENV === 'production') {
    app.enableCors({
      origin: [config.API_PUBLIC_URL],
      credentials: true,
    });
  } else {
    app.enableCors({
      origin: true,
      credentials: true,
    });
  }

  await app.listen(config.API_PORT, config.API_HOST);
  logger.info(
    `Krypton API Service running on http://${config.API_HOST}:${config.API_PORT}/api/v1 (ENV: ${config.NODE_ENV})`
  );
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to start Krypton API Service');
  process.exit(1);
});
