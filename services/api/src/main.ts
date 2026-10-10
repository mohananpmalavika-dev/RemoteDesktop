import { NestFactory } from '@nestjs/core';
import fs from 'fs';
import path from 'path';
import express from 'express';
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
    rawBody: true,
  });
  app.enableShutdownHooks();
  if (config.TRUST_PROXY) app.getHttpAdapter().getInstance().set('trust proxy', 1);

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
      origin: config.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean).concat(new URL(config.API_PUBLIC_URL).origin),
      credentials: true,
    });
  } else {
    app.enableCors({
      origin: true,
      credentials: true,
    });
  }

  // Serve static assets if public directory exists (production Web Viewer & Admin Console)
  const candidateDirs = [
    path.resolve(process.cwd(), 'public'),
    path.resolve(__dirname, '..', '..', 'public'),
    path.resolve(__dirname, '..', 'public'),
    path.resolve(process.cwd(), 'apps', 'admin-web', 'dist'),
  ];
  const publicDir = candidateDirs.find((dir) => fs.existsSync(dir));
  if (publicDir) {
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.use(express.static(publicDir));
    // SPA fallback
    expressApp.use((req: any, res: any, next: () => void) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/health')) {
        res.sendFile(path.join(publicDir, 'index.html'));
      } else {
        next();
      }
    });
    logger.info(`Static frontend assets served from ${publicDir}`);
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
