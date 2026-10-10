import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

// The signature binds the identity to the exact request body, route and nonce.
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const deviceId = req.headers['x-device-id'];
    const timestamp = req.headers['x-device-timestamp'];
    const nonce = req.headers['x-device-nonce'];
    const signature = req.headers['x-device-signature'];
    const deny = () => new UnauthorizedException('Valid signed device authentication is required.');
    if (![deviceId, timestamp, nonce, signature].every(v => typeof v === 'string') ||
        !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000 ||
        !/^[a-f0-9]{32}$/.test(nonce) || !Buffer.isBuffer(req.rawBody)) throw deny();
    if (req.params.id && req.path.includes('/devices/') && req.params.id !== deviceId) throw deny();
    const device = await this.prisma.device.findUnique({ where: { id: deviceId },
      include: { deviceKeys: { where: { isActive: true } } } });
    if (!device || device.status === 'REVOKED' || !device.isEnrolled) throw deny();
    const digest = crypto.createHash('sha256').update(req.rawBody).digest('hex');
    const payload = `${req.method}\n${req.originalUrl}\n${timestamp}\n${nonce}\n${digest}`;
    const valid = device.deviceKeys.some(key => {
      try {
        const publicKey = crypto.createPublicKey({ key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key.publicKey, 'base64')
        ]), type: 'spki', format: 'der' });
        return crypto.verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64'));
      } catch { return false; }
    });
    if (!valid) throw deny();
    const claimed = await this.redis.getClient().set(`krypton:device:nonce:${deviceId}:${nonce}`, '1', 'EX', 120, 'NX');
    if (claimed !== 'OK') throw deny();
    req.device = { id: device.id, organizationId: device.organizationId };
    return true;
  }
}
