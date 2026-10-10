import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Monitor,
  Maximize2,
  Minimize2,
  Key,
  RefreshCw,
  Clipboard,
  AlertCircle,
  X,
  Layers,
  Activity,
} from "lucide-react";
import { ConnectionLaunch } from "./ConnectionLaunch";
import { SignalingMessageType, PROTOCOL_VERSION, FrameAssembler, EncodedFrame } from "@krypton/protocol";

import { FileSender, FileReceiver } from "../api/fileTransfer";
import { API_BASE, getAuthToken, apiRequest } from "../api/client";

interface WebRemoteViewerProps {
  apiBase?: string;
  autoConnect?: boolean;
  initialRemoteId?: string;
  onClose?: () => void;
}

interface TelemetryStats {
  rttMs: number;
  fps: number;
  bitrateKbps: number;
  packetLossPct: number;
  route: "DIRECT_P2P" | "TURN_RELAY";
}

export const WebRemoteViewer: React.FC<WebRemoteViewerProps> = ({
  initialRemoteId = "",
  apiBase = API_BASE,
  autoConnect = false,
  onClose,
}) => {
  const native = '__TAURI_INTERNALS__' in window;
  const viewerRequest = async (path: string, body: object, token?: string, signal?: AbortSignal) => {
    if (native) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<any>('viewer_api_request', { apiUrl: apiBase, path, body, token: token || null });
    }
    if (token && token === getAuthToken() && apiBase === API_BASE) {
      return apiRequest<any>(path, { method: 'POST', signal, body: JSON.stringify(body), keepalive: path.endsWith('/end') });
    }
    const response = await fetch(`${apiBase}${path}`, { method: 'POST', signal, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: JSON.stringify(body), keepalive: path.endsWith('/end') || path.endsWith('/guest-end') });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `API error ${response.status}`);
    return result;
  };
  const [remoteIdInput, setRemoteIdInput] = useState<string>(initialRemoteId);
  const [pinInput, setPinInput] = useState<string>("");
  const [connectionState, setConnectionState] = useState<
    | "DISCONNECTED"
    | "AUTHENTICATING"
    | "SIGNALING"
    | "CONNECTING"
    | "CONNECTED"
    | "FAILED"
  >("DISCONNECTED");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Viewer options
  const [fitMode, setFitMode] = useState<"fit" | "original">("fit");
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [showTelemetry, setShowTelemetry] = useState<boolean>(true);
  const [clipboardText, setClipboardText] = useState<string>("");
  const [showClipboardModal, setShowClipboardModal] = useState<boolean>(false);

  // Real-time telemetry
  const [telemetry, setTelemetry] = useState<TelemetryStats>({
    rttMs: 0,
    fps: 0,
    bitrateKbps: 0,
    packetLossPct: 0,
    route: "DIRECT_P2P",
  });

  // DOM Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // WebRTC & WebSocket Refs
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const controlChannelRef = useRef<RTCDataChannel | null>(null);
  const clipboardChannelRef = useRef<RTCDataChannel | null>(null);
  const sequenceRef = useRef<number>(1);
  const fileSenderRef = useRef<FileSender | null>(null);
  const downloadsRef = useRef<string[]>([]);
  const [downloads, setDownloads] = useState<{ name: string; url: string }[]>([]);
  const fileReceiverRef = useRef<FileReceiver | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileProgress, setFileProgress] = useState<string>('');
  const sessionIdRef = useRef<string>("");
  const statsTimerRef = useRef<any>(null);
  const frameCountRef = useRef<number>(0);
  const lastFpsTimestampRef = useRef<number>(performance.now());
  const decoderRef = useRef<VideoDecoder | null>(null);
  const assemblerRef = useRef(new FrameAssembler());
  const sessionTokenRef = useRef<string>('');
  const guestRef = useRef(false);
  const attemptRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const capabilitiesRef = useRef({ screenView: false, control: false, clipboard: false, fileTransfer: false });
  const [acceptedCaps, setAcceptedCaps] = useState(capabilitiesRef.current);
  const [decodedVideo, setDecodedVideo] = useState(false);

  // Sequence generator for DataChannel messages
  const nextSeq = useCallback(() => {
    sequenceRef.current += 1;
    return sequenceRef.current;
  }, []);

  // Format 9-digit Remote ID with spaces (e.g. 123 456 789)
  const formatRemoteId = (val: string) => {
    const clean = val.replace(/\D/g, "").slice(0, 9);
    if (clean.length <= 3) return clean;
    if (clean.length <= 6) return `${clean.slice(0, 3)} ${clean.slice(3)}`;
    return `${clean.slice(0, 3)} ${clean.slice(3, 6)} ${clean.slice(6)}`;
  };

  useEffect(() => {
    if (initialRemoteId) setRemoteIdInput(formatRemoteId(initialRemoteId));
  }, [initialRemoteId]);

  // Close connection cleanly
  const disconnect = useCallback(() => {
    for (const url of downloadsRef.current) URL.revokeObjectURL(url); downloadsRef.current = []; setDownloads([]);
    fileReceiverRef.current?.clear(); fileReceiverRef.current = null;
    fileSenderRef.current?.close(); fileSenderRef.current = null; setFileProgress('');
    attemptRef.current++;
    abortRef.current?.abort(); abortRef.current = null;
    if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
    connectTimeoutRef.current = null;
    const sessionId = sessionIdRef.current;
    if (sessionId && sessionTokenRef.current) {
      void viewerRequest(`/sessions/${sessionId}/${guestRef.current ? 'guest-end' : 'end'}`, {}, sessionTokenRef.current).catch(() => {});
    }
    sessionIdRef.current = ''; sessionTokenRef.current = ''; candidatesRef.current = [];
    assemblerRef.current.clear(); capabilitiesRef.current = { screenView: false, control: false, clipboard: false, fileTransfer: false };
    setAcceptedCaps(capabilitiesRef.current); setDecodedVideo(false);
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }

    if (controlChannelRef.current) {
      try {
        controlChannelRef.current.close();
      } catch {}
      controlChannelRef.current = null;
    }
    if (clipboardChannelRef.current) {
      try {
        clipboardChannelRef.current.close();
      } catch {}
      clipboardChannelRef.current = null;
    }

    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }

    if (decoderRef.current) {
      try {
        decoderRef.current.close();
      } catch {}
      decoderRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setConnectionState("DISCONNECTED");
    setStatusMessage("");
  }, [apiBase]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  // Send Remote Control message over RTCDataChannel
  const sendControlMessage = useCallback((msg: any) => {
    if (!capabilitiesRef.current.control) return;
    if (
      !controlChannelRef.current ||
      controlChannelRef.current.readyState !== "open"
    ) {
      return;
    }
    try {
      controlChannelRef.current.send(JSON.stringify(msg));
    } catch (err) {
      console.warn("[WebViewer] Failed to send control message:", err);
    }
  }, []);

  // Mouse move handler
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement | HTMLVideoElement>) => {
      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

      sendControlMessage({
        type: "mouse_move",
        v: 1,
        x,
        y,
        displayId: 0,
        sequence: nextSeq(),
        timestamp: Date.now(),
      });
    },
    [sendControlMessage, nextSeq],
  );

  // Mouse button handler (down / up)
  const handleMouseButton = useCallback(
    (
      e: React.MouseEvent<HTMLCanvasElement | HTMLVideoElement>,
      state: "down" | "up",
    ) => {
      e.preventDefault();
      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

      let button = "left";
      if (e.button === 2) button = "right";
      else if (e.button === 1) button = "middle";

      sendControlMessage({
        type: "mouse_button",
        v: 1,
        button,
        state,
        x,
        y,
        displayId: 0,
        sequence: nextSeq(),
        timestamp: Date.now(),
      });
    },
    [sendControlMessage, nextSeq],
  );

  // Mouse wheel handler
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement | HTMLVideoElement>) => {
      e.preventDefault();
      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

      sendControlMessage({
        type: "mouse_wheel",
        v: 1,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        x,
        y,
        displayId: 0,
        sequence: nextSeq(),
        timestamp: Date.now(),
      });
    },
    [sendControlMessage, nextSeq],
  );

  // Keyboard events
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      sendControlMessage({
        type: "key_down",
        v: 1,
        virtualKey: e.keyCode || e.which,
        sequence: nextSeq(),
        timestamp: Date.now(),
      });
    },
    [sendControlMessage, nextSeq],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      sendControlMessage({
        type: "key_up",
        v: 1,
        virtualKey: e.keyCode || e.which,
        sequence: nextSeq(),
        timestamp: Date.now(),
      });
    },
    [sendControlMessage, nextSeq],
  );

  // Windows system combo triggers
  const sendSpecialCombo = (
    combo: "CtrlAltDel" | "AltTab" | "WinKey" | "CtrlShiftEsc",
  ) => {
    sendControlMessage({
      type: "special_combo",
      v: 1,
      combo,
      sequence: nextSeq(),
      timestamp: Date.now(),
    });
  };

  // Clipboard sync
  const sendClipboardText = (text: string) => {
    if (!capabilitiesRef.current.clipboard || new TextEncoder().encode(text).length > 1_048_576) return;
    if (
      !clipboardChannelRef.current ||
      clipboardChannelRef.current.readyState !== "open"
    )
      return;
    try {
      clipboardChannelRef.current.send(
        JSON.stringify({ text, timestamp: Date.now() }),
      );
    } catch (err) {
      console.warn("[WebViewer] Clipboard send failed:", err);
    }
  };

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch((err) => {
        console.warn("Fullscreen error:", err);
      });
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch((err) => {
        console.warn("Exit fullscreen error:", err);
      });
      setIsFullscreen(false);
    }
  };

  // Main Connect Flow
  const handleConnect = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanId = remoteIdInput.replace(/\s+/g, "");
    if (!/^\d{9}$/.test(cleanId)) {
      setErrorMessage("Please enter a valid 9-digit Remote ID.");
      return;
    }

    disconnect();
    const attempt = attemptRef.current;
    const controller = new AbortController(); abortRef.current = controller;
    setErrorMessage(null);
    setConnectionState("AUTHENTICATING");
    setStatusMessage("Initiating secure session with API...");

    try {
      let token = native ? null : getAuthToken();
      const sessionData = await viewerRequest(`/sessions/${token ? '' : 'quick-connect'}`,
        token ? { targetRemoteId: cleanId, requestedCapabilities: { screenView: true, control: true, clipboard: true, fileTransfer: true, audioListen: false } } : { targetRemoteId: cleanId, pin: pinInput || undefined },
        token || undefined, controller.signal);
      if (token) token = getAuthToken();
      if (attempt !== attemptRef.current) {
        void viewerRequest(`/sessions/${sessionData.sessionId}/${token ? 'end' : 'guest-end'}`, {}, token || sessionData.accessToken).catch(() => {}); return;
      }
      sessionIdRef.current = sessionData.sessionId;
      guestRef.current = !token; sessionTokenRef.current = token || sessionData.accessToken;
      setConnectionState('SIGNALING'); setStatusMessage('Waiting for the host to approve this session...');
      connectTimeoutRef.current = setTimeout(() => { disconnect(); setErrorMessage('Host approval or connection timed out. Try again.'); }, 300_000);
      if (!sessionData.signalingUrl) throw new Error('The server did not provide a signaling URL.');
      const ws = new WebSocket(sessionData.signalingUrl); wsRef.current = ws;
      const iceServers = sessionData.iceConfiguration.iceServers;

      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: "all",
      });
      pcRef.current = pc;

      // Create primary bidirectional DataChannels
      const controlChannel = pc.createDataChannel("remote-control", {
        ordered: true,
      });
      controlChannelRef.current = controlChannel;

      controlChannel.onopen = () => {
        console.info("[WebRTC] remote-control DataChannel is OPEN");
      };

      const clipboardChannel = pc.createDataChannel("clipboard", {
        ordered: true,
      });
      clipboardChannelRef.current = clipboardChannel;

      clipboardChannel.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && typeof data.text === "string" && capabilitiesRef.current.clipboard) {
            setClipboardText(data.text);
          }
        } catch {}
      };

      const fileChannel = pc.createDataChannel('file-transfer', { ordered: true });
      const fileSender = new FileSender(fileChannel); fileSenderRef.current = fileSender;
      const fileReceiver = new FileReceiver(fileChannel, (name, blob) => {
        const url = URL.createObjectURL(blob); downloadsRef.current.push(url); setDownloads(previous => [...previous, { name, url }]);
      }); fileReceiverRef.current = fileReceiver;
      let fileQueue = Promise.resolve();
      fileChannel.onmessage = event => {
        fileQueue = fileQueue.then(async () => {
          if (!capabilitiesRef.current.fileTransfer || typeof event.data !== 'string' || event.data.length > 65536) return;
          const message = JSON.parse(event.data); if (!fileSender.onMessage(message)) await fileReceiver.onMessage(message);
        }).catch(error => { if (fileChannel.readyState === 'open') fileChannel.send(JSON.stringify({ action: 'error', message: String(error) })); setFileProgress(String(error)); });
      };
      fileChannel.onclose = () => fileSender.close();
      const telemetryChannel = pc.createDataChannel("telemetry", {
        ordered: false,
        maxRetransmits: 0,
      });
      telemetryChannel.onmessage = (event) => {
        try {
          const stats = JSON.parse(event.data);
          if (stats) {
            setTelemetry((prev) => ({
              ...prev,
              fps: stats.fps || prev.fps,
              bitrateKbps: stats.bitrateKbps || prev.bitrateKbps,
            }));
          }
        } catch {}
      };

      // Handle incoming remote media tracks (Video Stream)
      pc.ontrack = (event) => {
        console.info("[WebRTC] Remote media track received:", event.track.kind);
        if (event.track.kind === "video") {
          if (videoRef.current) {
            videoRef.current.srcObject = event.streams[0];
            videoRef.current
              .play()
              .catch((e) => console.warn("Video auto-play deferred:", e));
          }
        }
      };

      // Handle DataChannels created by the remote peer
      pc.ondatachannel = (event) => {
        console.info(
          "[WebRTC] Remote peer opened DataChannel:",
          event.channel.label,
        );
        if (event.channel.label === "video") {
          // Hardware H.264 WebCodecs packet stream
          event.channel.binaryType = "arraybuffer";
          event.channel.onmessage = (msgEvent) => {
            try { const frame = assemblerRef.current.push(msgEvent.data); if (frame) handleEncodedVideoChunk(frame); }
            catch (error) { setErrorMessage(String(error)); }
          };
        }
      };

      // Trickle ICE candidates to remote host via signaling
      pc.onicecandidate = (event) => {
        if (event.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              version: PROTOCOL_VERSION,
              type: SignalingMessageType.ICE_CANDIDATE,
              correlationId: crypto.randomUUID(),
              timestamp: Date.now(),
              payload: {
                sessionId: sessionIdRef.current,
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
              },
            }),
          );
        }
      };

      // Connection State Changes
      pc.onconnectionstatechange = () => {
        console.info("[WebRTC] Connection state changed:", pc.connectionState);
        if (attempt !== attemptRef.current) return;
        if (pc.connectionState === "connected") {
          if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
          setConnectionState("CONNECTED");
          setStatusMessage("Connected. Real-time control active.");
          startTelemetryMonitoring(pc);
        } else if (pc.connectionState === "connecting") {
          setConnectionState("CONNECTING");
          setStatusMessage("Negotiating peer-to-peer route...");
        } else if (pc.connectionState === "failed") {
          disconnect(); setConnectionState("FAILED");
          setErrorMessage(
            "Peer connection failed. Check host availability and firewall.",
          );
        } else if (pc.connectionState === "disconnected") {
          setStatusMessage("Connection interrupted. Attempting reconnect...");
          if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = setTimeout(() => {
            if (attempt === attemptRef.current && pc.connectionState === 'disconnected') {
              disconnect(); setErrorMessage('The connection could not recover. Start a new support session.');
            }
          }, 15_000);
        }
      };

      // WebSocket Signaling Events
      ws.onopen = () => {
        console.info(
          "[Signaling] WebSocket open. Waiting for Auth Challenge...",
        );
      };

      let processing = Promise.resolve();
      ws.onmessage = (event) => {
        processing = processing.then(async () => {
        if (attempt !== attemptRef.current) return;
        try {
          const msg = JSON.parse(event.data);

          // 1. Auth Challenge -> Submit JWT
          if (msg.type === SignalingMessageType.AUTH_CHALLENGE) {
            ws.send(
              JSON.stringify({
                version: PROTOCOL_VERSION,
                type: SignalingMessageType.AUTH_SUBMIT,
                correlationId: msg.correlationId,
                timestamp: Date.now(),
                payload: {
                  subjectType: "USER",
                  accessToken: sessionTokenRef.current,
                },
              }),
            );
            return;
          }

          if (msg.type === SignalingMessageType.AUTH_SUCCESS) {
            ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: SignalingMessageType.SESSION_REQUEST,
              correlationId: crypto.randomUUID(), timestamp: Date.now(), payload: {
                sessionId: sessionData.sessionId, viewerUserId: msg.payload.subjectId, viewerName: 'Viewer',
                organizationName: 'Workspace', targetDeviceId: sessionData.targetDeviceId,
                requestedCapabilities: sessionData.requestedCapabilities,
              } }));
            return;
          }
          if (msg.type === SignalingMessageType.SESSION_ACCEPT) {
            if (msg.payload.sessionId !== sessionIdRef.current || pc.localDescription) return;
            capabilitiesRef.current = msg.payload.acceptedCapabilities; setAcceptedCaps(msg.payload.acceptedCapabilities);
            setStatusMessage('Host approved. Negotiating an encrypted connection...');
            const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: SignalingMessageType.OFFER,
              correlationId: crypto.randomUUID(), timestamp: Date.now(), payload: { sessionId: sessionData.sessionId, sdp: offer.sdp } }));
            return;
          }
          if (msg.type === SignalingMessageType.SESSION_REJECT) {
            disconnect(); setErrorMessage(msg.payload.reason || 'The host declined this session.'); return;
          }

          // 3. Receive SDP Answer from Host
          if (msg.type === SignalingMessageType.ANSWER) {
            setStatusMessage(
              "Received remote answer. Finalizing connection...",
            );
            await pc.setRemoteDescription(
              new RTCSessionDescription({
                type: "answer",
                sdp: msg.payload.sdp,
              }),
            );
            for (const candidate of candidatesRef.current.splice(0)) await pc.addIceCandidate(candidate);
            return;
          }

          // 4. Receive Remote ICE Candidates
          if (msg.type === SignalingMessageType.ICE_CANDIDATE) {
            const cand = msg.payload;
            if (cand && cand.candidate) {
              const candidate = { candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex };
              if (pc.remoteDescription) await pc.addIceCandidate(candidate);
              else if (candidatesRef.current.length < 128) candidatesRef.current.push(candidate);
            }
            return;
          }

          // 5. Host Session End
          if (msg.type === SignalingMessageType.SESSION_END) {
            disconnect();
            setErrorMessage(
              `Host ended session: ${msg.payload.reason || "Normal close"}`,
            );
            return;
          }

          if (msg.type === SignalingMessageType.ERROR) {
            setErrorMessage(
              `Signaling Error: ${msg.payload.message || "Unknown"}`,
            );
          }
        } catch (err: any) {
          disconnect(); setErrorMessage(err.message || "Signaling failed.");
        }
        }).catch(error => { disconnect(); setErrorMessage(String(error)); });
      };

      ws.onerror = (err) => {
        if (attempt !== attemptRef.current) return;
        disconnect();
        console.error("[Signaling] WebSocket error:", err);
        setErrorMessage(
          "Could not reach the support service. Check your connection and server settings.",
        );
        setConnectionState("FAILED");
      };

      ws.onclose = () => {
        if (attempt !== attemptRef.current) return;
        disconnect(); setErrorMessage("The signaling connection closed. Reconnect to start a new session.");
      };
    } catch (err: any) {
      if (attempt !== attemptRef.current) return;
      disconnect();
      console.error("[WebViewer] Connection failure:", err);
      setErrorMessage(err.message || "Failed to initiate remote session.");
      setConnectionState("FAILED");
    }
  };

  // Decode the host's Annex-B H.264 frames with dimensions and timestamps from its capture pipeline.
  const handleEncodedVideoChunk = (frame: EncodedFrame) => {
    if (!('VideoDecoder' in window)) { setErrorMessage('This browser does not support remote video decoding. Use a current Chromium browser.'); return; }
    if (decoderRef.current && (decoderRef.current.decodeQueueSize > 6 ||
        canvasRef.current?.width !== frame.width || canvasRef.current?.height !== frame.height)) {
      decoderRef.current.close(); decoderRef.current = null;
    }
    if (!decoderRef.current) {
      if (!frame.isKeyframe) return;
      const canvas = canvasRef.current; if (!canvas) return;
      canvas.width = frame.width; canvas.height = frame.height;
      let codec = 'avc1.42E01E';
      for (let i = 0; i + 7 < frame.data.length; i++) {
        const start = frame.data[i] === 0 && frame.data[i + 1] === 0 && frame.data[i + 2] === 1 ? i + 3 :
          frame.data[i] === 0 && frame.data[i + 1] === 0 && frame.data[i + 2] === 0 && frame.data[i + 3] === 1 ? i + 4 : -1;
        if (start >= 0 && (frame.data[start] & 31) === 7) {
          codec = `avc1.${Array.from(frame.data.subarray(start + 1, start + 4)).map(v => v.toString(16).padStart(2, '0')).join('')}`; break;
        }
      }
      const decoder = new VideoDecoder({ output: videoFrame => {
        canvas.getContext('2d')?.drawImage(videoFrame, 0, 0, canvas.width, canvas.height); videoFrame.close();
        frameCountRef.current++; setDecodedVideo(true);
      }, error: error => { setErrorMessage(`Video decoding failed: ${error.message}`); decoderRef.current?.close(); decoderRef.current = null; } });
      decoder.configure({ codec, codedWidth: frame.width, codedHeight: frame.height, optimizeForLatency: true }); decoderRef.current = decoder;
    }
    if (decoderRef.current.state === 'configured') decoderRef.current.decode(new EncodedVideoChunk({ type: frame.isKeyframe ? 'key' : 'delta', timestamp: Math.round(frame.ptsUs), data: frame.data }));
  };

  useEffect(() => {
    if (autoConnect && /^\d{9}$/.test(initialRemoteId.replace(/\s/g, ''))) void handleConnect();
  }, []);

  // Real-time WebRTC telemetry poller
  const startTelemetryMonitoring = (pc: RTCPeerConnection) => {
    if (statsTimerRef.current) clearInterval(statsTimerRef.current);

    statsTimerRef.current = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        let rtt = 0;
        let routeType: "DIRECT_P2P" | "TURN_RELAY" = "DIRECT_P2P";

        stats.forEach((report) => {
          if (
            report.type === "candidate-pair" &&
            report.state === "succeeded" && report.nominated
          ) {
            rtt = Math.round((report.currentRoundTripTime || 0) * 1000);
            const remoteReport = stats.get(report.remoteCandidateId);
            if (
              remoteReport &&
              (remoteReport.candidateType === "relay" ||
                stats.get(report.localCandidateId)?.candidateType === "relay")
            ) {
              routeType = "TURN_RELAY";
            }
          }
        });

        // Calculate FPS
        const now = performance.now();
        const delta = (now - lastFpsTimestampRef.current) / 1000;
        const currentFps =
          delta > 0 ? Math.round(frameCountRef.current / delta) : 0;
        frameCountRef.current = 0;
        lastFpsTimestampRef.current = now;

        setTelemetry((prev) => ({
          ...prev,
          rttMs: rtt > 0 ? rtt : prev.rttMs,
          fps: currentFps,
          route: routeType,
        }));
      } catch {}
    }, 1500);
  };

  if (connectionState === "DISCONNECTED") {
    return (
      <ConnectionLaunch
        remoteId={remoteIdInput}
        pin={pinInput}
        error={errorMessage}
        onRemoteIdChange={(value) => {
          setRemoteIdInput(formatRemoteId(value));
          setErrorMessage(null);
        }}
        onPinChange={setPinInput}
        onConnect={handleConnect}
      />
    );
  }

  return (
    <div
      className="web-viewer-session"
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: "650px",
        backgroundColor: "#07090e",
        color: "#f8fafc",
        position: "relative",
        borderRadius: isFullscreen ? "0px" : "12px",
        overflow: "hidden",
        border: isFullscreen ? "none" : "1px solid rgba(255, 255, 255, 0.08)",
      }}
    >
      <div style={{ padding: '8px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
        <button disabled={!acceptedCaps.fileTransfer || connectionState !== 'CONNECTED'} onClick={() => fileInputRef.current?.click()}>Send file to host</button>
        <input ref={fileInputRef} type="file" hidden onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file || !fileSenderRef.current) return;
          setFileProgress('Preparing file?');
          try { await fileSenderRef.current.send(file, progress => setFileProgress(`${file.name}: ${progress}%`)); setFileProgress(`${file.name}: verified and saved on host`); }
          catch (error) { setFileProgress(String(error)); }
        }} />
        <span role="status">{fileProgress}</span>
        {downloads.map(file => <a key={file.url} href={file.url} download={file.name}>Save {file.name}</a>)}
      </div>
      {/* ── Top Header / Control Toolbar ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          backgroundColor: "#0c1017",
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
          zIndex: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "32px",
              height: "32px",
              borderRadius: "8px",
              backgroundColor: "rgba(56, 189, 248, 0.12)",
              color: "#38bdf8",
            }}
          >
            <Monitor size={18} />
          </div>
          <div>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <span>Web Remote Viewer</span>
              <span
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  backgroundColor:
                    connectionState === "CONNECTED"
                      ? "rgba(34, 197, 94, 0.2)"
                      : "rgba(148, 163, 184, 0.15)",
                  color:
                    connectionState === "CONNECTED" ? "#4ade80" : "#94a3b8",
                }}
              >
                {connectionState}
              </span>
            </div>
          </div>
        </div>

        {/* Remote Actions when Connected */}
        {connectionState === "CONNECTED" && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              disabled
              title="Secure attention is unavailable for attended sessions"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 10px",
                borderRadius: "6px",
                backgroundColor: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: "#e2e8f0",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <Key size={14} />
              <span>Ctrl+Alt+Del</span>
            </button>

            <button
              disabled={!acceptedCaps.control} onClick={() => sendSpecialCombo("WinKey")}
              title="Open Start Menu (Win Key)"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 10px",
                borderRadius: "6px",
                backgroundColor: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: "#e2e8f0",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <span>🪟 Win</span>
            </button>

            <button
              disabled={!acceptedCaps.control} onClick={() => sendSpecialCombo("AltTab")}
              title="Switch Application (Alt+Tab)"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 10px",
                borderRadius: "6px",
                backgroundColor: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: "#e2e8f0",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <RefreshCw size={14} />
              <span>Alt+Tab</span>
            </button>

            <button
              disabled={!acceptedCaps.clipboard} onClick={() => setShowClipboardModal(true)}
              title="Sync Clipboard"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 10px",
                borderRadius: "6px",
                backgroundColor: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: "#e2e8f0",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <Clipboard size={14} />
              <span>Clipboard</span>
            </button>

            <button
              onClick={() => setShowTelemetry(!showTelemetry)}
              title="Toggle HUD Telemetry"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 10px",
                borderRadius: "6px",
                backgroundColor: showTelemetry
                  ? "rgba(56, 189, 248, 0.15)"
                  : "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: showTelemetry ? "#38bdf8" : "#e2e8f0",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <Activity size={14} />
              <span>Stats</span>
            </button>

            <button
              onClick={() => setFitMode(fitMode === "fit" ? "original" : "fit")}
              title="Toggle Fit Mode"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 10px",
                borderRadius: "6px",
                backgroundColor: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: "#e2e8f0",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <Layers size={14} />
              <span>{fitMode === "fit" ? "Fit Window" : "1:1 Pixel"}</span>
            </button>

            <button
              onClick={toggleFullscreen}
              title="Fullscreen"
              style={{
                padding: "6px 10px",
                borderRadius: "6px",
                backgroundColor: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: "#e2e8f0",
                cursor: "pointer",
              }}
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>

            <button
              onClick={disconnect}
              style={{
                padding: "6px 12px",
                borderRadius: "6px",
                backgroundColor: "#dc2626",
                border: "none",
                color: "#ffffff",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Disconnect
            </button>
          </div>
        )}

        {onClose && (
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              padding: "4px",
            }}
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* ── Main Viewport Area ── */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          backgroundColor: "#030712",
          overflow: fitMode === "fit" ? "hidden" : "auto",
        }}
      >
        {/* State: Connecting / Handshake Spinner */}
        {(connectionState === "AUTHENTICATING" ||
          connectionState === "SIGNALING" ||
          connectionState === "CONNECTING") && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "16px",
              padding: "32px",
              backgroundColor: "#0f172a",
              borderRadius: "16px",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              maxWidth: "380px",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "50%",
                border: "3px solid rgba(56, 189, 248, 0.2)",
                borderTopColor: "#38bdf8",
                animation: "spin 1s linear infinite",
              }}
            />
            <style>{`
              @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
              }
            `}</style>
            <div style={{ fontSize: "16px", fontWeight: 600 }}>
              Connecting to Host
            </div>
            <div style={{ fontSize: "13px", color: "#94a3b8" }}>
              {statusMessage}
            </div>
            <button
              onClick={disconnect}
              style={{
                marginTop: "8px",
                padding: "6px 14px",
                borderRadius: "6px",
                backgroundColor: "rgba(255, 255, 255, 0.08)",
                border: "none",
                color: "#cbd5e1",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* State: Connection Error */}
        {connectionState === "FAILED" && (
          <div
            style={{
              maxWidth: "420px",
              padding: "32px",
              backgroundColor: "#0f172a",
              borderRadius: "16px",
              border: "1px solid rgba(239, 68, 68, 0.2)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "50%",
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                color: "#ef4444",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 16px auto",
              }}
            >
              <AlertCircle size={24} />
            </div>
            <h3
              style={{
                fontSize: "16px",
                fontWeight: 600,
                color: "#f8fafc",
                margin: "0 0 8px 0",
              }}
            >
              Connection Failed
            </h3>
            <p
              style={{
                fontSize: "13px",
                color: "#94a3b8",
                margin: "0 0 20px 0",
              }}
            >
              {errorMessage ||
                "Unable to establish peer connection with the remote machine."}
            </p>
            <div
              style={{ display: "flex", gap: "10px", justifyContent: "center" }}
            >
              <button
                onClick={() => setConnectionState("DISCONNECTED")}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  backgroundColor: "rgba(255, 255, 255, 0.08)",
                  border: "none",
                  color: "#f8fafc",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                onClick={() => handleConnect()}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  backgroundColor: "#0284c7",
                  border: "none",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* State: Connected Live Canvas / Video Stream */}
        {connectionState === "CONNECTED" && (
          <div
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              outline: "none",
              cursor: "default",
            }}
          >
            {/* HTML5 Video Track display (Primary WebRTC Stream) */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              onMouseMove={handleMouseMove}
              onMouseDown={(e) => handleMouseButton(e, "down")}
              onMouseUp={(e) => handleMouseButton(e, "up")}
              onContextMenu={(e) => e.preventDefault()}
              onWheel={handleWheel}
              style={{
                maxWidth: fitMode === "fit" ? "100%" : "none",
                maxHeight: fitMode === "fit" ? "100%" : "none",
                width: fitMode === "fit" ? "100%" : "auto",
                height: fitMode === "fit" ? "100%" : "auto",
                objectFit: fitMode === "fit" ? "contain" : "none",
                display: decodedVideo ? "none" : "block",
              }}
            />

            {/* Hardware WebCodecs Canvas (Fallback/DataChannel Stream) */}
            <canvas
              ref={canvasRef}
              width={1920}
              height={1080}
              onMouseMove={handleMouseMove}
              onMouseDown={(e) => handleMouseButton(e, "down")}
              onMouseUp={(e) => handleMouseButton(e, "up")}
              onContextMenu={(e) => e.preventDefault()}
              onWheel={handleWheel}
              style={{
                display: decodedVideo || !videoRef.current?.srcObject ? "block" : "none",
                maxWidth: fitMode === "fit" ? "100%" : "none",
                maxHeight: fitMode === "fit" ? "100%" : "none",
                width: fitMode === "fit" ? "100%" : "auto",
                height: fitMode === "fit" ? "100%" : "auto",
                objectFit: "contain",
              }}
            />
          </div>
        )}

        {/* Real-time Telemetry HUD (Bottom-left overlay) */}
        {connectionState === "CONNECTED" && showTelemetry && (
          <div
            style={{
              position: "absolute",
              bottom: "12px",
              left: "12px",
              display: "flex",
              alignItems: "center",
              gap: "12px",
              padding: "6px 12px",
              borderRadius: "8px",
              backgroundColor: "rgba(15, 23, 42, 0.85)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              fontSize: "12px",
              color: "#cbd5e1",
              zIndex: 30,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <div
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor:
                    telemetry.route === "DIRECT_P2P" ? "#22c55e" : "#38bdf8",
                }}
              />
              <span style={{ fontWeight: 600 }}>{telemetry.route}</span>
            </div>

            <div>
              <span>RTT: </span>
              <span style={{ color: "#ffffff", fontWeight: 600 }}>
                {telemetry.rttMs} ms
              </span>
            </div>

            <div>
              <span>FPS: </span>
              <span style={{ color: "#ffffff", fontWeight: 600 }}>
                {telemetry.fps}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Clipboard Modal */}
      {showClipboardModal && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            style={{
              width: "450px",
              backgroundColor: "#0f172a",
              borderRadius: "12px",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              padding: "24px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "16px",
              }}
            >
              <h3 style={{ fontSize: "16px", fontWeight: 600, margin: 0 }}>
                Sync Clipboard
              </h3>
              <button
                disabled={!acceptedCaps.clipboard} onClick={() => setShowClipboardModal(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#94a3b8",
                  cursor: "pointer",
                }}
              >
                <X size={18} />
              </button>
            </div>

            <textarea
              rows={5}
              placeholder="Paste text here to send to remote host..."
              value={clipboardText}
              onChange={(e) => setClipboardText(e.target.value)}
              style={{
                width: "100%",
                padding: "12px",
                borderRadius: "8px",
                backgroundColor: "#1e293b",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                color: "#ffffff",
                fontSize: "13px",
                fontFamily: "monospace",
                outline: "none",
                boxSizing: "border-box",
                resize: "none",
              }}
            />

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
                marginTop: "16px",
              }}
            >
              <button
                disabled={!acceptedCaps.clipboard} onClick={() => setShowClipboardModal(false)}
                style={{
                  padding: "8px 14px",
                  borderRadius: "6px",
                  backgroundColor: "rgba(255, 255, 255, 0.08)",
                  border: "none",
                  color: "#cbd5e1",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  sendClipboardText(clipboardText);
                  setShowClipboardModal(false);
                }}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  backgroundColor: "#0284c7",
                  border: "none",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Send to Remote Host
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
