import React, { useEffect, useRef, useState, useCallback } from 'react';

interface DisplayInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  is_primary: boolean;
  refresh_rate: number;
  x: number;
  y: number;
}

interface CaptureStatus {
  active: boolean;
  displayId?: number;
  fps?: number;
}

interface RemoteCanvasProps {
  /** Session ID for isolating IPC events */
  sessionId: string;
  /** Whether this instance is a remote viewer (true) or a host agent preview (false) */
  isViewer?: boolean;
  /** Called when capture starts successfully */
  onCaptureStarted?: (displayId: number) => void;
  /** Called when capture stops */
  onCaptureStopped?: () => void;
  /** Called on error */
  onError?: (msg: string) => void;
  /** Whether the host granted remote input control capability */
  allowInputControl?: boolean;
  /** Whether the host granted remote clipboard synchronization capability */
  allowClipboard?: boolean;
  /** Whether the host granted file transfer capability */
  allowFileTransfer?: boolean;
}

/**
 * RemoteCanvas — renders live encoded video frames from the Rust capture pipeline,
 * captures user input (Phase 5), and provides Productivity Suite tools (Phase 6:
 * multi-monitor switching, clipboard sync, and resumable file transfer).
 */
export const RemoteCanvas: React.FC<RemoteCanvasProps> = ({
  sessionId,
  isViewer = false,
  onCaptureStarted,
  onCaptureStopped,
  onError,
  allowInputControl = true,
  allowClipboard = false,
  allowFileTransfer = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const frameCountRef = useRef(0);
  const lastFrameTimeRef = useRef(performance.now());
  const renderedFrameCountRef = useRef(0);
  const lastMouseMoveTimeRef = useRef(0);
  const sequenceRef = useRef(1);

  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [selectedDisplay, setSelectedDisplay] = useState<number>(0);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>({ active: false });
  const [measuredFps, setMeasuredFps] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Input control state
  const [inputEnabled, setInputEnabled] = useState<boolean>(allowInputControl);
  const [inputStats, setInputStats] = useState<{ mouseEvents: number; keyEvents: number }>({
    mouseEvents: 0,
    keyEvents: 0,
  });

  // Phase 6: Clipboard Synchronization state
  const [clipboardStatus, setClipboardStatus] = useState<string | null>(null);

  const handleSyncClipboard = async () => {
    if (!allowClipboard) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const payload = await invoke<{ text: string; hash: string } | null>('read_clipboard');
      if (payload && payload.text) {
        if (isViewer) {
          await invoke('send_remote_clipboard', { text: payload.text });
        }
        setClipboardStatus(`Synced ${payload.text.length} chars`);
      } else {
        setClipboardStatus('Clipboard up to date');
      }
      setTimeout(() => setClipboardStatus(null), 3000);
    } catch (e: any) {
      setError(`Clipboard error: ${e}`);
    }
  };

  // Phase 6: Resumable File Transfer state
  const [showFileTransfer, setShowFileTransfer] = useState(false);
  const [transferStatus, setTransferStatus] = useState<{
    filename: string;
    progress: number;
    state: string;
    bytes: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!allowFileTransfer || !event.target.files || event.target.files.length === 0) return;
    const file = event.target.files[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const sha256Buffer = await crypto.subtle.digest('SHA-256', buffer);
      const sha256 = Array.from(new Uint8Array(sha256Buffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const chunkSize = 65536;
      const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
      const transferId = `tx-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

      setTransferStatus({
        filename: file.name,
        progress: 0,
        state: 'Negotiating metadata',
        bytes: 0,
      });

      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('prepare_file_download', {
        metadata: {
          transfer_id: transferId,
          filename: file.name,
          file_size_bytes: file.size,
          chunk_size: chunkSize,
          total_chunks: totalChunks,
          sha256_checksum: sha256,
        },
      });

      let transferredBytes = 0;
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const chunkData = new Uint8Array(buffer.slice(start, end));

        await invoke('receive_file_chunk', {
          chunk: {
            transfer_id: transferId,
            chunk_index: i,
            total_chunks: totalChunks,
            data: Array.from(chunkData),
          },
        });

        transferredBytes += chunkData.length;
        const progress = Math.round((transferredBytes / (file.size || 1)) * 100);
        setTransferStatus({
          filename: file.name,
          progress,
          state: i === totalChunks - 1 ? 'Verifying SHA-256 checksum' : `Transferring chunk ${i + 1}/${totalChunks}`,
          bytes: transferredBytes,
        });
      }

      setTransferStatus({
        filename: file.name,
        progress: 100,
        state: 'Completed & Verified',
        bytes: file.size,
      });
    } catch (e: any) {
      setError(`File transfer error: ${e?.message || e}`);
      setTransferStatus((prev) => (prev ? { ...prev, state: 'Failed' } : null));
    }
  };

  // Phase 6: Multi-Monitor Switching
  const handleSwitchDisplay = async (newDisplayId: number) => {
    setSelectedDisplay(newDisplayId);
    if (captureStatus.active) {
      try {
        setLoading(true);
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('switch_capture_display', {
          displayId: newDisplayId,
          fps: 30,
          bitrateKbps: 2000,
          sessionId,
        });
        setCaptureStatus({ active: true, displayId: newDisplayId });
        onCaptureStarted?.(newDisplayId);
      } catch (e: any) {
        setError(`Failed to switch display: ${e}`);
      } finally {
        setLoading(false);
      }
    }
  };

  // Measure actual rendered FPS
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    fpsIntervalRef.current = setInterval(() => {
      const now = performance.now();
      const elapsed = (now - lastFrameTimeRef.current) / 1000;
      const fps = renderedFrameCountRef.current / elapsed;
      setMeasuredFps(Math.round(fps));
      renderedFrameCountRef.current = 0;
      lastFrameTimeRef.current = now;
    }, 1000);
    return () => {
      if (fpsIntervalRef.current !== undefined) {
        clearInterval(fpsIntervalRef.current);
      }
    };
  }, []);

  // Sync allowInputControl prop
  useEffect(() => {
    setInputEnabled(allowInputControl);
  }, [allowInputControl]);

  // Initialize WebCodecs VideoDecoder
  const initDecoder = useCallback((width: number, height: number) => {
    if (typeof VideoDecoder === 'undefined') {
      console.warn('[canvas] WebCodecs VideoDecoder not available — using raw BGRA path');
      return;
    }
    if (decoderRef.current) {
      decoderRef.current.close();
    }

    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        const canvas = canvasRef.current;
        if (!canvas) { frame.close(); return; }
        const ctx = canvas.getContext('2d');
        if (!ctx) { frame.close(); return; }
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
        renderedFrameCountRef.current++;
      },
      error: (e) => {
        console.error('[canvas] Decoder error:', e);
        setError(`Decoder error: ${e.message}`);
        onError?.(`Decoder error: ${e.message}`);
      },
    });

    decoder.configure({
      codec: 'avc1.42E01E', // H.264 Baseline Level 3.0
      codedWidth: width,
      codedHeight: height,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    });

    decoderRef.current = decoder;
    console.info(`[canvas] VideoDecoder configured ${width}x${height}`);
  }, [onError]);

  // Enumerate displays via Tauri command
  const loadDisplays = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result: DisplayInfo[] = await invoke('get_capture_displays');
      setDisplays(result);
      const primary = result.find(d => d.is_primary) ?? result[0];
      if (primary) setSelectedDisplay(primary.id);
    } catch (e: any) {
      const msg = `Failed to enumerate displays: ${e}`;
      setError(msg);
      onError?.(msg);
    }
  }, [onError]);

  useEffect(() => {
    loadDisplays();
    return () => {
      if (decoderRef.current) {
        decoderRef.current.close();
        decoderRef.current = null;
      }
    };
  }, [loadDisplays]);

  // Viewer Mode (Section 6 & 16): automatically initialize decoder and listen for incoming remote WebRTC frames
  useEffect(() => {
    if (!isViewer) return;

    let unlistenFn: (() => void) | undefined;
    let isSubscribed = true;

    (async () => {
      try {
        if (canvasRef.current) {
          canvasRef.current.width = 1920;
          canvasRef.current.height = 1080;
        }
        initDecoder(1920, 1080);

        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen<{ data: number[]; isKeyframe: boolean; ptsNs: number }>(
          `krypton://frame/${sessionId}`,
          ({ payload }) => {
            if (!decoderRef.current || decoderRef.current.state !== 'configured') return;

            const chunk = new EncodedVideoChunk({
              type: payload.isKeyframe ? 'key' : 'delta',
              timestamp: payload.ptsNs / 1000, // ns → µs
              data: new Uint8Array(payload.data),
            });

            try {
              decoderRef.current.decode(chunk);
              frameCountRef.current++;
            } catch (e) {
              console.warn('[canvas] decode error:', e);
            }
          }
        );

        if (isSubscribed) {
          unlistenFn = unlisten;
          setCaptureStatus({ active: true, displayId: 0, fps: 30 });
        } else {
          unlisten();
        }
      } catch (err: any) {
        setError(`Viewer stream init failed: ${err}`);
      }
    })();

    return () => {
      isSubscribed = false;
      if (unlistenFn) unlistenFn();
    };
  }, [isViewer, sessionId, initDecoder]);

  // Start capture
  const handleStartCapture = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const selected = displays.find(d => d.id === selectedDisplay);
      if (!selected) throw new Error('No display selected');

      // Start capture on Rust side
      const msg: string = await invoke('start_capture', {
        displayId: selectedDisplay,
        fps: 30,
        bitrateKbps: 3000,
        sessionId,
      });
      console.info('[canvas] Capture started:', msg);

      // Size canvas to display dimensions
      if (canvasRef.current) {
        canvasRef.current.width = selected.width;
        canvasRef.current.height = selected.height;
      }

      // Initialize decoder at display resolution
      initDecoder(selected.width, selected.height);

      // Subscribe to encoded frame events from Tauri
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<{ data: number[]; isKeyframe: boolean; ptsNs: number }>(
        `krypton://frame/${sessionId}`,
        ({ payload }) => {
          if (!decoderRef.current || decoderRef.current.state !== 'configured') return;

          const chunk = new EncodedVideoChunk({
            type: payload.isKeyframe ? 'key' : 'delta',
            timestamp: payload.ptsNs / 1000, // ns → µs
            data: new Uint8Array(payload.data),
          });

          try {
            decoderRef.current.decode(chunk);
            frameCountRef.current++;
          } catch (e) {
            console.warn('[canvas] decode error:', e);
          }
        }
      );

      setCaptureStatus({ active: true, displayId: selectedDisplay, fps: 30 });
      onCaptureStarted?.(selectedDisplay);

      return () => { unlisten(); };
    } catch (e: any) {
      const msg = `Start capture failed: ${e?.message ?? e}`;
      setError(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  }, [displays, selectedDisplay, sessionId, initDecoder, onCaptureStarted, onError]);

  // Stop capture
  const handleStopCapture = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('stop_capture');
      setCaptureStatus({ active: false });
      onCaptureStopped?.();

      // Clear canvas
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    } catch (e: any) {
      setError(`Stop capture failed: ${e?.message ?? e}`);
    }
  }, [onCaptureStopped]);

  // Helper to get normalized coordinates from mouse event
  const getNormalizedPoint = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return { x, y };
  }, []);

  const getDisplayBounds = useCallback(() => {
    const current = displays.find(d => d.id === selectedDisplay);
    return {
      x: current?.x ?? 0,
      y: current?.y ?? 0,
      width: current?.width ?? 1920,
      height: current?.height ?? 1080,
      dpi_scale: 1.0,
    };
  }, [displays, selectedDisplay]);

  // Mouse Move
  const handleMouseMove = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!captureStatus.active || !inputEnabled) return;
    const now = performance.now();
    if (now - lastMouseMoveTimeRef.current < 16) return; // Limit to ~60Hz
    lastMouseMoveTimeRef.current = now;

    const point = getNormalizedPoint(e);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (isViewer) {
        await invoke('send_remote_control', {
          message: {
            type: 'mouse_move',
            v: 1,
            x: point.x,
            y: point.y,
            displayId: selectedDisplay,
            sequence: sequenceRef.current++,
            timestamp: Date.now(),
          },
        });
      } else {
        await invoke('inject_mouse_input', {
          action: { Move: { point } },
          bounds: getDisplayBounds(),
        });
      }
      setInputStats(prev => ({ ...prev, mouseEvents: prev.mouseEvents + 1 }));
    } catch (err) {
      console.debug('[input] mouse move error:', err);
    }
  }, [captureStatus.active, inputEnabled, isViewer, getNormalizedPoint, selectedDisplay, getDisplayBounds]);

  // Mouse Down
  const handleMouseDown = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!captureStatus.active || !inputEnabled) return;
    canvasRef.current?.focus();

    const point = getNormalizedPoint(e);
    const button = e.button === 2 ? 'Right' : e.button === 1 ? 'Middle' : 'Left';

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (isViewer) {
        await invoke('send_remote_control', {
          message: {
            type: 'mouse_button',
            v: 1,
            button: button.toLowerCase(),
            state: 'down',
            x: point.x,
            y: point.y,
            displayId: selectedDisplay,
            sequence: sequenceRef.current++,
            timestamp: Date.now(),
          },
        });
      } else {
        await invoke('inject_mouse_input', {
          action: { ButtonDown: { button, point } },
          bounds: getDisplayBounds(),
        });
      }
      setInputStats(prev => ({ ...prev, mouseEvents: prev.mouseEvents + 1 }));
    } catch (err) {
      console.debug('[input] mouse down error:', err);
    }
  }, [captureStatus.active, inputEnabled, isViewer, getNormalizedPoint, selectedDisplay, getDisplayBounds]);

  // Mouse Up
  const handleMouseUp = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!captureStatus.active || !inputEnabled) return;
    const point = getNormalizedPoint(e);
    const button = e.button === 2 ? 'Right' : e.button === 1 ? 'Middle' : 'Left';

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (isViewer) {
        await invoke('send_remote_control', {
          message: {
            type: 'mouse_button',
            v: 1,
            button: button.toLowerCase(),
            state: 'up',
            x: point.x,
            y: point.y,
            displayId: selectedDisplay,
            sequence: sequenceRef.current++,
            timestamp: Date.now(),
          },
        });
      } else {
        await invoke('inject_mouse_input', {
          action: { ButtonUp: { button, point } },
          bounds: getDisplayBounds(),
        });
      }
      setInputStats(prev => ({ ...prev, mouseEvents: prev.mouseEvents + 1 }));
    } catch (err) {
      console.debug('[input] mouse up error:', err);
    }
  }, [captureStatus.active, inputEnabled, isViewer, getNormalizedPoint, selectedDisplay, getDisplayBounds]);

  // Mouse Wheel
  const handleWheel = useCallback(async (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!captureStatus.active || !inputEnabled) return;
    e.preventDefault();

    const deltaX = Math.sign(e.deltaX);
    const deltaY = -Math.sign(e.deltaY);

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (isViewer) {
        await invoke('send_remote_control', {
          message: {
            type: 'mouse_wheel',
            v: 1,
            deltaX,
            deltaY,
            x: 0.5,
            y: 0.5,
            displayId: selectedDisplay,
            sequence: sequenceRef.current++,
            timestamp: Date.now(),
          },
        });
      } else {
        await invoke('inject_mouse_input', {
          action: { Scroll: { delta_x: deltaX, delta_y: deltaY } },
          bounds: getDisplayBounds(),
        });
      }
      setInputStats(prev => ({ ...prev, mouseEvents: prev.mouseEvents + 1 }));
    } catch (err) {
      console.debug('[input] wheel error:', err);
    }
  }, [captureStatus.active, inputEnabled, isViewer, selectedDisplay, getDisplayBounds]);

  // Context Menu
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (captureStatus.active && inputEnabled) {
      e.preventDefault();
    }
  }, [captureStatus.active, inputEnabled]);

  // Key Down
  const handleKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!captureStatus.active || !inputEnabled) return;
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) return;

    e.preventDefault();
    e.stopPropagation();

    const virtualKey = e.keyCode || 0;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (isViewer) {
        await invoke('send_remote_control', {
          message: {
            type: 'key_down',
            v: 1,
            virtualKey,
            sequence: sequenceRef.current++,
            timestamp: Date.now(),
          },
        });
      } else {
        await invoke('inject_keyboard_input', {
          action: { KeyDown: { virtual_key: virtualKey } },
        });
      }
      setInputStats(prev => ({ ...prev, keyEvents: prev.keyEvents + 1 }));
    } catch (err) {
      console.debug('[input] keydown error:', err);
    }
  }, [captureStatus.active, inputEnabled, isViewer]);

  // Key Up
  const handleKeyUp = useCallback(async (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!captureStatus.active || !inputEnabled) return;
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) return;

    e.preventDefault();
    e.stopPropagation();

    const virtualKey = e.keyCode || 0;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (isViewer) {
        await invoke('send_remote_control', {
          message: {
            type: 'key_up',
            v: 1,
            virtualKey,
            sequence: sequenceRef.current++,
            timestamp: Date.now(),
          },
        });
      } else {
        await invoke('inject_keyboard_input', {
          action: { KeyUp: { virtual_key: virtualKey } },
        });
      }
      setInputStats(prev => ({ ...prev, keyEvents: prev.keyEvents + 1 }));
    } catch (err) {
      console.debug('[input] keyup error:', err);
    }
  }, [captureStatus.active, inputEnabled, isViewer]);

  // Special System Combos
  const handleSpecialCombo = useCallback(async (combo: string) => {
    if (!captureStatus.active || !inputEnabled) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (isViewer) {
        await invoke('send_remote_control', {
          message: {
            type: 'special_combo',
            v: 1,
            combo,
            sequence: sequenceRef.current++,
            timestamp: Date.now(),
          },
        });
      } else {
        await invoke('send_special_combo', { combo });
      }
      console.info(`[input] Sent special combo: ${combo}`);
    } catch (err: any) {
      console.warn(`[input] Error sending combo ${combo}:`, err);
    }
  }, [captureStatus.active, inputEnabled, isViewer]);

  return (
    <div className="remote-canvas-container">
      {/* Display selector & control toolbar */}
      <div className="canvas-toolbar">
        <select
          id="display-selector"
          className="display-selector"
          value={selectedDisplay}
          onChange={e => setSelectedDisplay(Number(e.target.value))}
          disabled={captureStatus.active}
        >
          {displays.length === 0 && <option value="">Loading displays...</option>}
          {displays.map(d => (
            <option key={d.id} value={d.id}>
              {d.name} {d.is_primary ? '(Primary)' : ''} — {d.width}×{d.height}
            </option>
          ))}
        </select>

        {!captureStatus.active ? (
          <button
            id="btn-start-capture"
            className="btn-capture-start"
            onClick={handleStartCapture}
            disabled={loading || displays.length === 0}
          >
            {loading ? 'Starting…' : '▶ Start Capture'}
          </button>
        ) : (
          <button
            id="btn-stop-capture"
            className="btn-capture-stop"
            onClick={handleStopCapture}
          >
            ⏹ Stop Capture
          </button>
        )}

        {/* Remote Control Input Toggle (Phase 5) */}
        {captureStatus.active && (
          <div className="input-toolbar-controls" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              id="btn-toggle-input"
              className={`btn-control-toggle ${inputEnabled ? 'active' : 'inactive'}`}
              onClick={() => setInputEnabled(!inputEnabled)}
              title={inputEnabled ? 'Input active (Click to disable)' : 'Input disabled (Click to enable)'}
              style={{
                padding: '5px 10px',
                borderRadius: '5px',
                fontSize: '11px',
                fontWeight: 600,
                border: '1px solid var(--border-color)',
                backgroundColor: inputEnabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                color: inputEnabled ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {inputEnabled ? '🎮 Control: Active' : '👁 View Only'}
            </button>

            {inputEnabled && (
              <div className="special-combo-group" style={{ display: 'flex', gap: 4 }}>
                <button
                  className="btn-combo-pill"
                  onClick={() => handleSpecialCombo('CtrlAltDel')}
                  title="Send Ctrl+Alt+Del to remote device"
                  style={btnComboStyle}
                >
                  Ctrl+Alt+Del
                </button>
                <button
                  className="btn-combo-pill"
                  onClick={() => handleSpecialCombo('WinKey')}
                  title="Send Windows key"
                  style={btnComboStyle}
                >
                  WinKey
                </button>
                <button
                  className="btn-combo-pill"
                  onClick={() => handleSpecialCombo('AltTab')}
                  title="Send Alt+Tab"
                  style={btnComboStyle}
                >
                  Alt+Tab
                </button>
                <button
                  className="btn-combo-pill"
                  onClick={() => handleSpecialCombo('CtrlShiftEsc')}
                  title="Open Task Manager (Ctrl+Shift+Esc)"
                  style={btnComboStyle}
                >
                  TaskMgr
                </button>
              </div>
            )}

            {/* Multi-Monitor Fast Switcher (Phase 6) */}
            {displays.length > 1 && (
              <div className="display-quick-switch" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Display:</span>
                {displays.map(d => (
                  <button
                    key={d.id}
                    className={`btn-display-pill ${selectedDisplay === d.id ? 'active' : ''}`}
                    onClick={() => handleSwitchDisplay(d.id)}
                    style={{
                      ...btnComboStyle,
                      backgroundColor: selectedDisplay === d.id ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                      color: selectedDisplay === d.id ? '#fff' : 'var(--text-secondary)',
                    }}
                  >
                    {d.name.replace('\\\\.\\DISPLAY', 'Mon ')} {d.is_primary ? '★' : ''}
                  </button>
                ))}
              </div>
            )}

            {/* Clipboard Synchronization (Phase 6) */}
            <button
              id="btn-sync-clipboard"
              onClick={handleSyncClipboard}
              disabled={!allowClipboard}
              title={allowClipboard ? 'Synchronize clipboard' : 'Clipboard capability not granted by host'}
              style={{
                ...btnComboStyle,
                opacity: allowClipboard ? 1 : 0.4,
                cursor: allowClipboard ? 'pointer' : 'not-allowed',
                backgroundColor: clipboardStatus ? 'var(--status-online)' : 'var(--bg-tertiary)',
                color: clipboardStatus ? '#000' : 'var(--text-secondary)',
              }}
            >
              📋 {clipboardStatus || (allowClipboard ? 'Sync Clipboard' : 'Clipboard Off')}
            </button>

            {/* File Transfer Drawer Toggle (Phase 6) */}
            <button
              id="btn-toggle-file-transfer"
              onClick={() => setShowFileTransfer(!showFileTransfer)}
              disabled={!allowFileTransfer}
              title={allowFileTransfer ? 'Open file transfer panel' : 'File transfer capability not granted by host'}
              style={{
                ...btnComboStyle,
                opacity: allowFileTransfer ? 1 : 0.4,
                cursor: allowFileTransfer ? 'pointer' : 'not-allowed',
                backgroundColor: showFileTransfer ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                color: showFileTransfer ? '#fff' : 'var(--text-secondary)',
              }}
            >
              📁 File Transfer
            </button>
          </div>
        )}

        {captureStatus.active && (
          <div className="canvas-stats">
            <span className="stat-pill" style={{ color: 'var(--status-online)' }}>
              ● LIVE
            </span>
            <span className="stat-pill">{measuredFps} FPS</span>
            <span className="stat-pill">Display {captureStatus.displayId}</span>
            {inputEnabled && (
              <span className="stat-pill" title="Injected mouse/key events">
                Inputs: {inputStats.mouseEvents + inputStats.keyEvents}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Phase 6: File Transfer Modal / Drawer */}
      {showFileTransfer && allowFileTransfer && (
        <div className="file-transfer-panel" style={{
          backgroundColor: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-color)',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', fontWeight: 600 }}>Resumable Chunked File Transfer</span>
            <button
              onClick={() => setShowFileTransfer(false)}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              style={{ display: 'none' }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                ...btnComboStyle,
                backgroundColor: 'var(--accent-primary)',
                color: '#fff',
                padding: '6px 12px',
              }}
            >
              Choose File to Send
            </button>
            {transferStatus && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                  <span>{transferStatus.filename} ({transferStatus.state})</span>
                  <span>{transferStatus.progress}%</span>
                </div>
                <div style={{
                  height: 6,
                  backgroundColor: 'var(--bg-tertiary)',
                  borderRadius: 3,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${transferStatus.progress}%`,
                    height: '100%',
                    backgroundColor: transferStatus.progress === 100 ? 'var(--status-online)' : 'var(--accent-primary)',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="canvas-error" role="alert">
          ⚠ {error}
        </div>
      )}

      {/* The video canvas with full remote input event listeners */}
      <div className="canvas-wrapper">
        <canvas
          ref={canvasRef}
          id={`remote-canvas-${sessionId}`}
          className={`remote-canvas ${inputEnabled && captureStatus.active ? 'interactive' : ''}`}
          width={1920}
          height={1080}
          tabIndex={0}
          aria-label="Remote desktop video stream and input interaction surface"
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          style={{
            cursor: inputEnabled && captureStatus.active ? 'crosshair' : 'default',
            outline: 'none',
          }}
        />
        {!captureStatus.active && (
          <div className="canvas-placeholder">
            <div className="canvas-placeholder-icon">🖥</div>
            <p>Select a display and click Start Capture to begin</p>
            {displays.length > 0 && (
              <p className="canvas-placeholder-hint">
                {displays.length} display{displays.length > 1 ? 's' : ''} detected
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const btnComboStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: '4px',
  fontSize: '10px',
  fontWeight: 600,
  border: '1px solid var(--border-color)',
  backgroundColor: 'var(--bg-tertiary)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};
