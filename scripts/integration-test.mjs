// Runs against an explicitly disposable database. Never use production credentials.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';

assert.equal(process.env.KRYPTON_TEST_DATABASE, 'disposable', 'Set KRYPTON_TEST_DATABASE=disposable for an isolated test database');
assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL, 'Explicit test database and Redis URLs are required');
const env = { ...process.env, NODE_ENV: 'test', API_PORT: '4500', SIGNALING_PORT: '4501', API_HOST: '127.0.0.1',
  SIGNALING_HOST: '127.0.0.1', API_PUBLIC_URL: 'http://127.0.0.1:4500', SIGNALING_PUBLIC_URL: 'ws://127.0.0.1:4501/signaling',
  JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
  DEVICE_ENROLLMENT_SIGNING_KEY: crypto.randomBytes(32).toString('hex'), TURN_SECRET: crypto.randomBytes(32).toString('hex'),
  RATE_LIMIT_LOGIN_MAX: '100', RATE_LIMIT_SESSION_CREATE_MAX: '100', TRUST_PROXY: 'false', LOG_LEVEL: 'error' };
const api = 'http://127.0.0.1:4500/api/v1';
const processes = ['api', 'signaling'].map(service => spawn(process.execPath, [`services/${service}/dist/main.js`], { env, stdio: ['ignore', 'inherit', 'inherit'] }));
const sockets = [];
const prisma = new PrismaClient();
const orgs = [];

async function ready(url) {
  for (let i = 0; i < 100; i++) {
    if (processes.some(child => child.exitCode !== null)) throw new Error('A test service exited before readiness');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Service never became ready: ${url}`);
}
async function request(path, body, token, status = 201, headers = {}) {
  const response = await fetch(`${api}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
  return result;
}
function signed(path, body, deviceId, privateKey) {
  const timestamp = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
  const digest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const signature = crypto.sign(null, Buffer.from(`POST\n/api/v1${path}\n${timestamp}\n${nonce}\n${digest}`), privateKey).toString('base64');
  return { 'x-device-id': deviceId, 'x-device-timestamp': timestamp, 'x-device-nonce': nonce, 'x-device-signature': signature };
}
function signal(socket, type, payload) {
  socket.send(JSON.stringify({ version: '1.0', type, payload, correlationId: crypto.randomUUID(), timestamp: Date.now() }));
}
async function openSocket(auth) {
  const socket = new WebSocket(env.SIGNALING_PUBLIC_URL); sockets.push(socket);
  const backlog = [], pending = [];
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    const index = pending.findIndex(item => item.type === message.type);
    if (index >= 0) { const [item] = pending.splice(index, 1); clearTimeout(item.timer); item.resolve(message); }
    else backlog.push(message);
  });
  const wait = type => new Promise((resolve, reject) => {
    const index = backlog.findIndex(message => message.type === type);
    if (index >= 0) { resolve(backlog.splice(index, 1)[0]); return; }
    const item = { type, resolve, timer: setTimeout(() => {
      pending.splice(pending.indexOf(item), 1); reject(new Error(`Signaling timed out: ${type}`));
    }, 8000) }; pending.push(item);
  });
  socket.on('error', error => { for (const item of pending.splice(0)) { clearTimeout(item.timer); item.resolve({ type: 'SOCKET_ERROR', error }); } });
  const challenge = await wait('AUTH_CHALLENGE');
  signal(socket, 'AUTH_SUBMIT', auth(challenge.payload.nonce));
  assert.equal((await wait('AUTH_SUCCESS')).type, 'AUTH_SUCCESS');
  return { socket, wait };
}
try {
  await Promise.all([ready(`${api}/health/ready`), ready('http://127.0.0.1:4501/health/ready')]);
  await request('/devices', undefined, undefined, 401);
  const suffix = crypto.randomUUID().replaceAll('-', '');
  async function account(prefix) {
    const username = `${prefix}-${suffix}`, password = crypto.randomBytes(24).toString('hex');
    const registered = await request('/auth/register', { organizationName: username, username, email: `${username}@example.test`, password });
    orgs.push(registered.organizationId);
    return request('/auth/login', { username, password });
  }
  const admin = await account('admin'), other = await account('other');
  const enrollment = await request('/devices/enrollment-tokens', { expiresInHours: 1 }, admin.accessToken);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const enrollmentBody = { enrollmentToken: enrollment.token, deviceName: 'Integration host', hostname: 'test-host',
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    os: 'Windows', osVersion: '11', architecture: 'x86_64', agentVersion: '1.0.1' };
  const host = await request('/devices/enroll', enrollmentBody);
  await request('/devices/enroll', enrollmentBody, undefined, 403);
  await request('/sessions', { targetDeviceId: host.deviceId }, other.accessToken, 404);
  await request('/sessions/quick-connect', { targetRemoteId: host.remoteId }, undefined, 400);
  const heartbeat = { agentVersion: '1.0.1', os: 'Windows', osVersion: '11', architecture: 'x86_64', sessionCount: 0,
    cpuPercent: 10, memoryPercent: 20, uptimeSeconds: 30 };
  const path = `/devices/${host.deviceId}/heartbeat`, headers = signed(path, heartbeat, host.deviceId, privateKey);
  await request(path, heartbeat, undefined, 201, headers);
  await request(path, heartbeat, undefined, 401, headers);
  const deviceSocket = await openSocket(nonce => ({ subjectType: 'DEVICE', deviceId: host.deviceId, nonce,
    timestamp: Date.now(), signature: crypto.sign(null, Buffer.from(nonce), privateKey).toString('base64') }));
  const guest = await request('/sessions/quick-connect', { targetRemoteId: host.remoteId });
  assert.equal(guest.signalingUrl, env.SIGNALING_PUBLIC_URL);
  await request('/auth/me', undefined, guest.accessToken, 401);
  let viewerSocket = await openSocket(() => ({ subjectType: 'USER', accessToken: guest.accessToken }));
  const deniedSocket = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Unauthorized consent socket was not closed')), 8000);
    viewerSocket.socket.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  signal(viewerSocket.socket, 'SESSION_ACCEPT', { sessionId: guest.sessionId, acceptedCapabilities: guest.requestedCapabilities });
  assert.equal(await deniedSocket, 4003);
  viewerSocket = await openSocket(() => ({ subjectType: 'USER', accessToken: guest.accessToken }));
  const consentPath = `/sessions/${guest.sessionId}/accept`;
  await request(consentPath, { capabilities: guest.requestedCapabilities }, undefined, 401);
  const body = { capabilities: { screenView: true, control: false, clipboard: false, fileTransfer: false, audioListen: false } };
  await request(consentPath, body, undefined, 201, signed(consentPath, body, host.deviceId, privateKey));
  assert.equal((await viewerSocket.wait('SESSION_ACCEPT')).payload.acceptedCapabilities.control, false);
  const statePath = `/sessions/${guest.sessionId}/host-state`, connected = { state: 'CONNECTED' };
  await request(statePath, connected, undefined, 201, signed(statePath, connected, host.deviceId, privateKey));
  await request(`/sessions/${guest.sessionId}`, undefined, other.accessToken, 404);
  await request(`/sessions/${guest.sessionId}/guest-end`, {}, guest.accessToken);
  assert.equal((await deviceSocket.wait('SESSION_END')).payload.sessionId, guest.sessionId);
  await request(statePath, connected, undefined, 400, signed(statePath, connected, host.deviceId, privateKey));
  const verify = await request('/audit/verify', undefined, admin.accessToken, 200);
  assert.equal(verify.valid, true);
  await request('/auth/logout', { refreshToken: admin.refreshToken }, admin.accessToken);
  await request('/auth/me', undefined, admin.accessToken, 401);
  console.log('Integration passed: database migrations, health, registration, tenant isolation, enrollment, signed heartbeat/replay, signaling consent, guest scope, session end, audit integrity, logout revocation.');
} finally {
  for (const socket of sockets) socket.terminate();
  for (const child of processes) child.kill();
  if (orgs.length) await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
  await prisma.$disconnect();
}
