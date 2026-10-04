import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { getConfig } from '@krypton/config';
import { IceConfiguration, IceServerConfig } from '@krypton/protocol';

@Injectable()
export class IceCredentialsService {
  /**
   * Generates dynamic, short-lived TURN/STUN credentials using HMAC-SHA1 (RFC 5766 / RFC 8489)
   * Section 33 & 34: "Never hard-code TURN secrets in the client binary. Use short-lived TURN credentials."
   */
  generateIceConfiguration(userIdOrDeviceId: string, ttlSeconds?: number): IceConfiguration {
    const config = getConfig();
    const ttl = ttlSeconds || config.TURN_CREDENTIAL_TTL_SECONDS || 86400;
    const expiryTimestamp = Math.floor(Date.now() / 1000) + ttl;

    const username = `${expiryTimestamp}:${userIdOrDeviceId}`;
    const credential = crypto
      .createHmac('sha1', config.TURN_SECRET)
      .update(username)
      .digest('base64');

    const stunUrls = config.STUN_URLS.split(',').map((u) => u.trim());
    const turnUrls = config.TURN_URLS.split(',').map((u) => u.trim());

    const iceServers: IceServerConfig[] = [
      // Direct STUN server for reflexive candidate discovery (P2P preferred)
      {
        urls: stunUrls,
      },
      // Authenticated TURN relay server (UDP + TCP fallback)
      {
        urls: turnUrls,
        username,
        credential,
      },
    ];

    return {
      iceServers,
      iceTransportPolicy: 'all', // Try direct P2P first, fall back to TURN relay
    };
  }
}
