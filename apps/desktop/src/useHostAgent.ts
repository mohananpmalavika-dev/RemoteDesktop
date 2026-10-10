import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { AnySignalingMessageSchema, fragmentFrame, PROTOCOL_VERSION, SignalingMessageType } from '@krypton/protocol';
import { FileSender } from '../../admin-web/src/api/fileTransfer';
import { SessionCapabilities } from '@krypton/shared-types';

export interface HostRequest { sessionId: string; viewerUserId: string; viewerName: string; organizationName: string; requestedCapabilities: SessionCapabilities }
interface Policy { clipboardPolicy: string; idleTimeoutMin: number; maxFileMb: number }
interface Registration { deviceId: string; apiUrl: string; remoteId: string }
interface Display { id: number; x: number; y: number; width: number; height: number }
interface Frame { data: number[]; is_keyframe: boolean; pts_ns: number; width: number; height: number }

const send = (ws: WebSocket, type: SignalingMessageType, payload: object) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type, correlationId: crypto.randomUUID(), timestamp: Date.now(), payload }));
};

class HostAgent {
  ws: WebSocket | null = null;
  pc: RTCPeerConnection | null = null;
  private closed = false;
  private fileSender: FileSender | null = null;
  private sessionTimers = new Set<ReturnType<typeof setInterval>>();
  private timers = new Set<ReturnType<typeof setInterval>>();
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private unlisten: UnlistenFn | undefined;
  private accepted: { id: string; caps: SessionCapabilities; policy: Policy; lastActivity: number } | null = null;
  private acceptance: Promise<void> = Promise.resolve();
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private reconnectAttempt = 0;
  private ending: Promise<void> | null = null;
  private registration: Registration | null = null;

  constructor(private request: (request: HostRequest | null) => void, private status: (status: string) => void,
    private error: (error: string) => void) {}

  api<T>(path: string, body: object): Promise<T> { return invoke('device_api_request', { path, body }); }

  async start() {
    this.registration = await invoke<Registration | null>('get_device_registration');
    if (!this.registration || this.closed) return;
    await this.connect().catch(error => { this.error(String(error)); this.scheduleReconnect(); });
    const heartbeat = async () => {
      if (this.closed || !this.registration) return;
      try { await this.api(`/devices/${this.registration.deviceId}/heartbeat`, await invoke<object>('get_device_heartbeat')); }
      catch (error) { this.error(String(error)); await this.end('Host authorization or heartbeat failed'); }
    };
    await heartbeat();
    this.timers.add(setInterval(() => void heartbeat(), 15_000));
  }

  private async connect() {
    if (this.closed || !this.registration) return;
    const runtime = await this.api<{ signalingUrl: string }>(`/devices/${this.registration.deviceId}/runtime-config`, {});
    if (this.closed) return;
    const ws = new WebSocket(runtime.signalingUrl);
    this.ws = ws;
    this.status('Connecting to support service');
    let processing = Promise.resolve();
    ws.onmessage = event => {
      processing = processing.then(async () => {
        if (this.closed || this.ws !== ws) return;
        const msg = AnySignalingMessageSchema.parse(JSON.parse(event.data));
        if (msg.type === SignalingMessageType.AUTH_CHALLENGE) {
          const signature = await invoke<string>('sign_device_challenge', { nonce: msg.payload.nonce });
          send(ws, SignalingMessageType.AUTH_SUBMIT, { subjectType: 'DEVICE', deviceId: this.registration!.deviceId,
            nonce: msg.payload.nonce, signature, timestamp: Date.now() });
        } else if (msg.type === SignalingMessageType.AUTH_SUCCESS) {
          this.reconnectAttempt = 0; this.status('Ready for support requests'); this.error('');
        } else if (msg.type === SignalingMessageType.SESSION_REQUEST) {
          if (this.accepted) {
            await this.api(`/sessions/${msg.payload.sessionId}/reject`, { reason: 'Host is already in a support session' });
          } else this.request(msg.payload);
        } else if (msg.type === SignalingMessageType.OFFER) {
          await this.acceptance;
          if (!this.accepted || msg.payload.sessionId !== this.accepted.id || !this.pc) return;
          await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.payload.sdp });
          for (const candidate of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(candidate);
          const answer = await this.pc.createAnswer(); await this.pc.setLocalDescription(answer);
          send(ws, SignalingMessageType.ANSWER, { sessionId: this.accepted.id, sdp: answer.sdp });
        } else if (msg.type === SignalingMessageType.ICE_CANDIDATE) {
          if (msg.payload.sessionId !== this.accepted?.id) return;
          const candidate = { candidate: msg.payload.candidate, sdpMid: msg.payload.sdpMid, sdpMLineIndex: msg.payload.sdpMLineIndex };
          if (this.pc?.remoteDescription) await this.pc.addIceCandidate(candidate); else if (this.pendingCandidates.length < 128) this.pendingCandidates.push(candidate);
        } else if (msg.type === SignalingMessageType.SESSION_END) {
          if (msg.payload.sessionId === this.accepted?.id) await this.end(msg.payload.reason);
          this.request(null);
        }
      }).catch(error => { this.error(String(error)); });
    };
    ws.onerror = () => this.error('Could not connect to the support service.');
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return;
      this.status('Support service disconnected');
      void this.end('Signaling disconnected'); this.request(null);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => void this.connect().catch(error => {
      this.error(String(error)); this.scheduleReconnect();
    }), Math.min(30_000, 1000 * 2 ** this.reconnectAttempt++));
  }

  accept(request: HostRequest, caps: SessionCapabilities): Promise<void> {
    this.acceptance = this.begin(request, caps).catch(async error => { await this.end('Session setup failed'); throw error; });
    return this.acceptance;
  }

  private async begin(request: HostRequest, caps: SessionCapabilities) {
    if (this.accepted || this.closed) throw new Error('Host is busy or disconnected.');
    const result = await this.api<{ iceConfiguration: RTCConfiguration; policy: Policy }>(`/sessions/${request.sessionId}/accept`, { capabilities: caps });
    if (this.closed) { await this.api(`/sessions/${request.sessionId}/host-state`, { state: 'ENDED', reason: 'Host closed' }); return; }
    this.accepted = { id: request.sessionId, caps, policy: result.policy, lastActivity: Date.now() };
    this.pc = new RTCPeerConnection(result.iceConfiguration);
    const pc = this.pc;
    const video = pc.createDataChannel('video', { ordered: true });
    let frameId = 0, awaitingKeyframe = true, frameCount = 0, sentBytes = 0;
    const display = (await invoke<Display[]>('get_capture_displays'))[0];
    if (!display) throw new Error('No capturable display is available.');
    const bounds = { x: display.x, y: display.y, width: display.width, height: display.height, dpi_scale: 1 };
    pc.onicecandidate = event => {
      if (event.candidate && this.ws) send(this.ws, SignalingMessageType.ICE_CANDIDATE,
        { sessionId: request.sessionId, ...event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.status(`Support session active: ${request.viewerName}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') void this.end('Peer connection ended');
    };
    pc.ondatachannel = event => {
      const channel = event.channel;
      if (channel.label === 'file-transfer') this.fileSender = new FileSender(channel);
      let queue = Promise.resolve();
      const transfers = new Set<string>();
      channel.onmessage = event => {
        if (typeof event.data !== 'string' || event.data.length > 2_100_000) return;
        queue = queue.then(async () => {
          if (this.accepted?.id !== request.sessionId) return;
          const msg = JSON.parse(event.data);
          if (channel.label === 'file-transfer' && this.fileSender?.onMessage(msg)) return;
          this.accepted.lastActivity = Date.now();
          if (channel.label === 'remote-control' && caps.control) {
            await invoke('process_remote_control', { message: msg, bounds });
          } else if (channel.label === 'clipboard' && caps.clipboard && typeof msg.text === 'string') {
            await invoke('write_clipboard', { text: msg.text });
          } else if (channel.label === 'file-transfer' && caps.fileTransfer) {
            if (msg.action === 'metadata') {
              const meta = msg.metadata;
              if (!meta || meta.file_size_bytes > result.policy.maxFileMb * 1024 * 1024 || transfers.size >= 4) throw new Error('Transfer exceeds host policy limits.');
              await invoke('prepare_file_download', { metadata: meta }); transfers.add(meta.transfer_id);
              channel.send(JSON.stringify({ action: 'ready', transferId: meta.transfer_id }));
            } else if (msg.action === 'chunk' && transfers.has(msg.chunk?.transfer_id)) {
              const ack = await invoke<any>('receive_file_chunk', { chunk: msg.chunk });
              channel.send(JSON.stringify({ action: 'ack', ack }));
              if (ack.state === 'Completed') transfers.delete(msg.chunk.transfer_id);
            } else if (msg.action === 'resume' && transfers.has(msg.transferId)) {
              const status = await invoke<any>('get_file_transfer_status', { transferId: msg.transferId });
              channel.send(JSON.stringify({ action: 'resume', status }));
            } else if (msg.action === 'cancel' && transfers.has(msg.transferId)) {
              await invoke('cancel_file_transfer', { transferId: msg.transferId }); transfers.delete(msg.transferId);
            }
          }
        }).catch(error => {
          if (channel.readyState === 'open') channel.send(JSON.stringify({ action: 'error', message: String(error) }));
          this.error(String(error));
        });
      };
      if (channel.label === 'clipboard' && caps.clipboard && result.policy.clipboardPolicy === 'BIDIRECTIONAL') {
        let reading = false;
        this.sessionTimers.add(setInterval(async () => {
          if (reading || channel.readyState !== 'open' || this.accepted?.id !== request.sessionId) return;
          reading = true;
          try { const payload = await invoke<any>('read_clipboard'); if (payload) channel.send(JSON.stringify({ text: payload.text })); }
          catch (error) { this.error(String(error)); } finally { reading = false; }
        }, 1000));
      }
    };
    this.unlisten = await listen<Frame>(`krypton://frame/${request.sessionId}`, ({ payload }) => {
      if (!caps.screenView || video.readyState !== 'open' || this.accepted?.id !== request.sessionId) return;
      if (video.bufferedAmount > 2 * 1024 * 1024) { awaitingKeyframe = true; return; }
      if (awaitingKeyframe && !payload.is_keyframe) return;
      try {
        for (const packet of fragmentFrame({ data: new Uint8Array(payload.data), isKeyframe: payload.is_keyframe,
          ptsUs: payload.pts_ns / 1000, width: payload.width, height: payload.height }, frameId++)) video.send(packet);
        awaitingKeyframe = false; frameCount++; sentBytes += payload.data.length;
      } catch { awaitingKeyframe = true; }
    });
    try {
      await invoke('start_host_session', { sessionId: request.sessionId, viewerId: request.viewerUserId,
        allowScreenView: caps.screenView, allowControl: caps.control, allowClipboard: caps.clipboard, allowFileTransfer: caps.fileTransfer,
        displayId: display.id, fps: 15, bitrateKbps: 3000, iceServers: result.iceConfiguration.iceServers });
    } catch (error) { await this.end('Capture failed'); throw error; }
    let reporting = false, lastReport = performance.now();
    this.sessionTimers.add(setInterval(async () => {
      if (reporting || this.accepted?.id !== request.sessionId) return;
      if (Date.now() - this.accepted.lastActivity > result.policy.idleTimeoutMin * 60_000) { await this.end('Idle timeout'); return; }
      if (pc.connectionState !== 'connected' && pc.connectionState !== 'disconnected') return;
      reporting = true;
      try {
        const stats = await pc.getStats(); let rttMs: number | null = null, route = 'DIRECT_P2P';
        stats.forEach(report => { if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
          rttMs = report.currentRoundTripTime == null ? null : report.currentRoundTripTime * 1000;
          if (stats.get(report.localCandidateId)?.candidateType === 'relay' || stats.get(report.remoteCandidateId)?.candidateType === 'relay') route = 'TURN_RELAY';
        } });
        const elapsed = (performance.now() - lastReport) / 1000; lastReport = performance.now();
        const metrics = { fps: frameCount / elapsed, bitrateMbps: sentBytes * 8 / elapsed / 1e6, rttMs, packetLossPercent: null, route };
        frameCount = 0; sentBytes = 0;
        await this.api(`/sessions/${request.sessionId}/host-state`, { state: pc.connectionState === 'connected' ? 'CONNECTED' : 'DEGRADED', metrics });
      } catch (error) { this.error(String(error)); await this.end('Session authorization or reporting failed'); }
      finally { reporting = false; }
    }, 5000));
    this.request(null); this.status('Waiting for viewer connection');
  }

  async reject(request: HostRequest) { await this.api(`/sessions/${request.sessionId}/reject`, { reason: 'Host declined' }); this.request(null); }

  async sendFile(file: File, progress: (percent: number) => void) {
    if (!this.accepted?.caps.fileTransfer || !this.fileSender) throw new Error('File transfer was not approved.');
    if (file.size > this.accepted.policy.maxFileMb * 1024 * 1024) throw new Error('File exceeds workspace policy.');
    return this.fileSender.send(file, progress);
  }

  async end(reason = 'Host disconnected') {
    if (this.ending) return this.ending;
    for (const timer of this.sessionTimers) clearInterval(timer); this.sessionTimers.clear();
    this.fileSender?.close(); this.fileSender = null;
    const current = this.accepted; this.accepted = null;
    this.unlisten?.(); this.unlisten = undefined; this.pc?.close(); this.pc = null; this.pendingCandidates = [];
    this.ending = (async () => {
      await invoke('disconnect_session').catch(error => this.error(String(error)));
      if (current) await this.api(`/sessions/${current.id}/host-state`, { state: 'ENDED', reason }).catch(error => this.error(String(error)));
      this.status('Ready for support requests');
    })();
    try { await this.ending; } finally { this.ending = null; }
  }

  close() { this.closed = true; clearTimeout(this.reconnect); for (const timer of this.timers) clearInterval(timer); this.timers.clear(); this.ws?.close(); void this.end('Host application closed'); }
}

export function useHostAgent(enabled: boolean, remoteId: string) {
  const [request, setRequest] = useState<HostRequest | null>(null);
  const [status, setStatus] = useState('Enrollment required');
  const [error, setError] = useState('');
  const agent = useRef<HostAgent | null>(null);
  useEffect(() => {
    if (!enabled || !/^\d{3}\s?\d{3}\s?\d{3}$/.test(remoteId)) return;
    const instance = new HostAgent(setRequest, setStatus, setError); agent.current = instance;
    void instance.start().catch(error => setError(String(error)));
    return () => { instance.close(); agent.current = null; };
  }, [enabled, remoteId]);
  useEffect(() => {
    if (!request) return;
    const timer = setTimeout(() => { void agent.current?.reject(request).catch(() => {}); setRequest(null); }, 295_000);
    return () => clearTimeout(timer);
  }, [request]);
  return { request, status, error, accept: (caps: SessionCapabilities) => request ? agent.current?.accept(request, caps) : undefined,
    sendFile: (file: File, progress: (percent: number) => void) => agent.current?.sendFile(file, progress),
    reject: () => request ? agent.current?.reject(request) : undefined, disconnect: () => agent.current?.end() };
}
