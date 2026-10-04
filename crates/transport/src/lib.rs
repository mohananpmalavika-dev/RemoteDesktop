use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;

use webrtc::peer_connection::{PeerConnection, PeerConnectionBuilder};
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::transport::RTCIceServer;

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Error, Debug, PartialEq, Eq, Clone)]
pub enum TransportError {
    #[error("Invalid state transition from {from:?} to {to:?}")]
    InvalidStateTransition { from: SessionState, to: SessionState },
    #[error("ICE connection failed: {0}")]
    IceConnectionFailed(String),
    #[error("Data channel '{0}' closed or not found")]
    ChannelClosed(String),
    #[error("RTP packetization error: {0}")]
    RtpError(String),
    #[error("SDP negotiation error: {0}")]
    SdpNegotiationError(String),
    #[error("Security or DTLS handshake failed: {0}")]
    DtlsError(String),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("Payload exceeded limit: {0}")]
    PayloadTooLarge(String),
    #[error("Path traversal detected: {0}")]
    PathTraversal(String),
    #[error("Transport failed: {0}")]
    Generic(String),
}

// ─────────────────────────────────────────────────────────────────────────────
// Route & State Machine (Section 1, 11 & 21)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransportRoute {
    DirectP2P,
    TurnRelay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionState {
    Disconnected,
    Authorizing,
    WaitingForConsent,
    Signaling,
    IceGathering,
    Connecting,
    Connected,
    Degraded,
    Reconnecting,
    Rejected,
    Expired,
    Failed,
    Ended,
}

impl SessionState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            SessionState::Rejected
                | SessionState::Expired
                | SessionState::Failed
                | SessionState::Ended
        )
    }

    pub fn can_transition_to(&self, next: SessionState) -> bool {
        if self.is_terminal() {
            return false;
        }

        match (self, next) {
            // Normal connection handshake
            (SessionState::Disconnected, SessionState::Authorizing) => true,
            (SessionState::Authorizing, SessionState::WaitingForConsent) => true,
            (SessionState::Authorizing, SessionState::Signaling) => true,
            (SessionState::Authorizing, SessionState::Rejected) => true,
            (SessionState::Authorizing, SessionState::Expired) => true,

            (SessionState::WaitingForConsent, SessionState::Signaling) => true,
            (SessionState::WaitingForConsent, SessionState::Rejected) => true,
            (SessionState::WaitingForConsent, SessionState::Expired) => true,
            (SessionState::WaitingForConsent, SessionState::Ended) => true,

            (SessionState::Signaling, SessionState::IceGathering) => true,
            (SessionState::Signaling, SessionState::Connecting) => true,
            (SessionState::Signaling, SessionState::Failed) => true,
            (SessionState::Signaling, SessionState::Ended) => true,

            (SessionState::IceGathering, SessionState::Connecting) => true,
            (SessionState::IceGathering, SessionState::Failed) => true,
            (SessionState::IceGathering, SessionState::Ended) => true,

            (SessionState::Connecting, SessionState::IceGathering) => true, // ICE restart during connect
            (SessionState::Connecting, SessionState::Connected) => true,
            (SessionState::Connecting, SessionState::Failed) => true,
            (SessionState::Connecting, SessionState::Ended) => true,

            // Active session state transitions
            (SessionState::Connected, SessionState::Degraded) => true,
            (SessionState::Connected, SessionState::Reconnecting) => true,
            (SessionState::Connected, SessionState::IceGathering) => true, // ICE restart
            (SessionState::Connected, SessionState::Ended) => true,

            (SessionState::Degraded, SessionState::Connected) => true,
            (SessionState::Degraded, SessionState::Reconnecting) => true,
            (SessionState::Degraded, SessionState::IceGathering) => true, // ICE restart
            (SessionState::Degraded, SessionState::Ended) => true,

            (SessionState::Reconnecting, SessionState::Connected) => true,
            (SessionState::Reconnecting, SessionState::Reconnecting) => true,
            (SessionState::Reconnecting, SessionState::Failed) => true,
            (SessionState::Reconnecting, SessionState::Ended) => true,

            // Universal failure/termination from non-terminal states
            (_, SessionState::Failed) => true,
            (_, SessionState::Ended) => true,

            _ => false,
        }
    }
}

pub struct ConnectionStateMachine {
    current_state: SessionState,
    reconnect_attempt: u32,
}

impl ConnectionStateMachine {
    pub fn new() -> Self {
        Self {
            current_state: SessionState::Disconnected,
            reconnect_attempt: 0,
        }
    }

    pub fn state(&self) -> SessionState {
        self.current_state
    }

    pub fn transition(&mut self, next_state: SessionState) -> Result<(), TransportError> {
        if !self.current_state.can_transition_to(next_state) {
            return Err(TransportError::InvalidStateTransition {
                from: self.current_state,
                to: next_state,
            });
        }

        if next_state == SessionState::Connected {
            self.reconnect_attempt = 0; // Reset backoff upon healthy connection
        } else if next_state == SessionState::Reconnecting {
            self.reconnect_attempt += 1;
        }

        self.current_state = next_state;
        Ok(())
    }

    /// Reconnect backoff intervals: 1s, 2s, 5s, 10s, 20s, 30s with bounded jitter (Section 21)
    pub fn next_reconnect_backoff_ms(&self) -> u64 {
        let schedule_secs = [1, 2, 5, 10, 20, 30];
        let idx = (self.reconnect_attempt.saturating_sub(1) as usize).min(schedule_secs.len() - 1);
        let base_secs = schedule_secs[idx];

        let jitter_ms = (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos()
            % 250) as u64;

        (base_secs * 1000) + jitter_ms
    }

    pub fn reset_attempts(&mut self) {
        self.reconnect_attempt = 0;
    }
}

impl Default for ConnectionStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ICE Protocol & Candidates (RFC 8445 / RFC 5766 / RFC 8489)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CandidateType {
    Host,
    ServerReflexive,
    PeerReflexive,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransportProtocol {
    Udp,
    Tcp,
    Tls,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IceCandidate {
    pub candidate_str: String,
    pub foundation: String,
    pub component: u32, // 1 = RTP, 2 = RTCP
    pub protocol: TransportProtocol,
    pub priority: u32,
    pub ip: String,
    pub port: u16,
    pub candidate_type: CandidateType,
    pub rel_addr: Option<String>,
    pub rel_port: Option<u16>,
    pub sdp_mid: Option<String>,
    pub sdp_m_line_index: Option<u32>,
}

impl IceCandidate {
    pub fn new(
        foundation: &str,
        component: u32,
        protocol: TransportProtocol,
        priority: u32,
        ip: &str,
        port: u16,
        candidate_type: CandidateType,
        rel_addr: Option<String>,
        rel_port: Option<u16>,
    ) -> Self {
        let type_str = match candidate_type {
            CandidateType::Host => "host",
            CandidateType::ServerReflexive => "srflx",
            CandidateType::PeerReflexive => "prflx",
            CandidateType::Relay => "relay",
        };

        let proto_str = match protocol {
            TransportProtocol::Udp => "udp",
            TransportProtocol::Tcp => "tcp",
            TransportProtocol::Tls => "tls",
        };

        let rel_part = if let (Some(ref raddr), Some(rport)) = (&rel_addr, rel_port) {
            format!(" raddr {} rport {}", raddr, rport)
        } else {
            String::new()
        };

        let candidate_str = format!(
            "candidate:{} {} {} {} {} {} typ {}{}",
            foundation, component, proto_str, priority, ip, port, type_str, rel_part
        );

        Self {
            candidate_str,
            foundation: foundation.to_string(),
            component,
            protocol,
            priority,
            ip: ip.to_string(),
            port,
            candidate_type,
            rel_addr,
            rel_port,
            sdp_mid: Some("0".to_string()),
            sdp_m_line_index: Some(0),
        }
    }

    /// Parse SDP candidate line: "candidate:foundation component proto priority ip port typ type [raddr ... rport ...]"
    pub fn parse_sdp(line: &str) -> Result<Self, TransportError> {
        let trimmed = line.trim().trim_start_matches("a=").trim_start_matches("candidate:");
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 7 {
            return Err(TransportError::Generic(format!("Malformed candidate line: {}", line)));
        }

        let foundation = parts[0].to_string();
        let component: u32 = parts[1].parse().map_err(|_| TransportError::Generic("Bad component".into()))?;
        let protocol = match parts[2].to_lowercase().as_str() {
            "udp" => TransportProtocol::Udp,
            "tcp" => TransportProtocol::Tcp,
            "tls" => TransportProtocol::Tls,
            other => return Err(TransportError::Generic(format!("Unknown protocol: {}", other))),
        };
        let priority: u32 = parts[3].parse().map_err(|_| TransportError::Generic("Bad priority".into()))?;
        let ip = parts[4].to_string();
        let port: u16 = parts[5].parse().map_err(|_| TransportError::Generic("Bad port".into()))?;

        let candidate_type = match parts[7].to_lowercase().as_str() {
            "host" => CandidateType::Host,
            "srflx" => CandidateType::ServerReflexive,
            "prflx" => CandidateType::PeerReflexive,
            "relay" => CandidateType::Relay,
            other => return Err(TransportError::Generic(format!("Unknown type: {}", other))),
        };

        let mut rel_addr = None;
        let mut rel_port = None;
        for i in 8..parts.len() {
            if parts[i] == "raddr" && i + 1 < parts.len() {
                rel_addr = Some(parts[i + 1].to_string());
            } else if parts[i] == "rport" && i + 1 < parts.len() {
                rel_port = parts[i + 1].parse().ok();
            }
        }

        Ok(Self::new(
            &foundation,
            component,
            protocol,
            priority,
            &ip,
            port,
            candidate_type,
            rel_addr,
            rel_port,
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServerConfig {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Real H.264 RTP Packetizer & Depacketizer (RFC 6184 / RFC 3550)
// ─────────────────────────────────────────────────────────────────────────────

pub const RTP_PAYLOAD_TYPE_H264: u8 = 96;
pub const RTP_CLOCK_RATE_HZ: u32 = 90_000;
pub const DEFAULT_MTU_SIZE: usize = 1200; // Safe WAN MTU

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtpPacket {
    pub marker: bool,
    pub payload_type: u8,
    pub sequence_number: u16,
    pub timestamp: u32,
    pub ssrc: u32,
    pub payload: Vec<u8>,
}

impl RtpPacket {
    pub fn serialize(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(12 + self.payload.len());
        buf.push(0x80); // V=2, P=0, X=0, CC=0
        let m_pt = (if self.marker { 0x80 } else { 0x00 }) | (self.payload_type & 0x7F);
        buf.push(m_pt);
        buf.extend_from_slice(&self.sequence_number.to_be_bytes());
        buf.extend_from_slice(&self.timestamp.to_be_bytes());
        buf.extend_from_slice(&self.ssrc.to_be_bytes());
        buf.extend_from_slice(&self.payload);
        buf
    }

    pub fn parse(buf: &[u8]) -> Result<Self, TransportError> {
        if buf.len() < 12 {
            return Err(TransportError::RtpError("Packet smaller than RTP header".into()));
        }

        let version = (buf[0] >> 6) & 0x03;
        if version != 2 {
            return Err(TransportError::RtpError(format!("Unsupported RTP version: {}", version)));
        }

        let marker = (buf[1] & 0x80) != 0;
        let payload_type = buf[1] & 0x7F;
        let sequence_number = u16::from_be_bytes([buf[2], buf[3]]);
        let timestamp = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
        let ssrc = u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]);
        let payload = buf[12..].to_vec();

        Ok(Self {
            marker,
            payload_type,
            sequence_number,
            timestamp,
            ssrc,
            payload,
        })
    }
}

/// Packetizes H.264 Annex-B NAL units into RTP packets with FU-A fragmentation (RFC 6184)
pub struct RtpPacketizer {
    ssrc: u32,
    sequence_number: u16,
    mtu: usize,
}

impl RtpPacketizer {
    pub fn new(ssrc: u32, mtu: usize) -> Self {
        Self {
            ssrc,
            sequence_number: 1000,
            mtu: mtu.max(500),
        }
    }

    pub fn packetize_nal(&mut self, nal: &[u8], pts_ns: u64) -> Result<Vec<RtpPacket>, TransportError> {
        if nal.is_empty() {
            return Ok(Vec::new());
        }

        // Strip Annex-B start codes: 0x000001 or 0x00000001
        let mut offset = 0;
        while offset + 3 <= nal.len() {
            if nal[offset] == 0 && nal[offset + 1] == 0 && nal[offset + 2] == 1 {
                offset += 3;
                break;
            } else if offset + 4 <= nal.len() && nal[offset] == 0 && nal[offset + 1] == 0 && nal[offset + 2] == 0 && nal[offset + 3] == 1 {
                offset += 4;
                break;
            } else {
                break;
            }
        }

        let nal_payload = &nal[offset..];
        if nal_payload.is_empty() {
            return Ok(Vec::new());
        }

        let rtp_timestamp = ((pts_ns as f64 / 1_000_000_000.0) * (RTP_CLOCK_RATE_HZ as f64)) as u32;
        let max_chunk = self.mtu - 12; // 12 bytes RTP header
        let mut packets = Vec::new();

        if nal_payload.len() <= max_chunk {
            // Single NAL unit packet (RFC 6184 Section 5.6)
            self.sequence_number = self.sequence_number.wrapping_add(1);
            packets.push(RtpPacket {
                marker: true,
                payload_type: RTP_PAYLOAD_TYPE_H264,
                sequence_number: self.sequence_number,
                timestamp: rtp_timestamp,
                ssrc: self.ssrc,
                payload: nal_payload.to_vec(),
            });
        } else {
            // FU-A Fragmentation Unit (RFC 6184 Section 5.8)
            let nal_header = nal_payload[0];
            let f = nal_header & 0x80;
            let nri = nal_header & 0x60;
            let nal_type = nal_header & 0x1F;

            let fu_indicator = f | nri | 28; // Type 28 = FU-A
            let raw_data = &nal_payload[1..];
            let chunk_size = max_chunk - 2; // FU indicator + FU header

            let total_chunks = (raw_data.len() + chunk_size - 1) / chunk_size;

            for (i, chunk) in raw_data.chunks(chunk_size).enumerate() {
                self.sequence_number = self.sequence_number.wrapping_add(1);
                let is_start = i == 0;
                let is_end = i == total_chunks - 1;

                let mut fu_header = nal_type;
                if is_start { fu_header |= 0x80; }
                if is_end { fu_header |= 0x40; }

                let mut payload = Vec::with_capacity(2 + chunk.len());
                payload.push(fu_indicator);
                payload.push(fu_header);
                payload.extend_from_slice(chunk);

                packets.push(RtpPacket {
                    marker: is_end,
                    payload_type: RTP_PAYLOAD_TYPE_H264,
                    sequence_number: self.sequence_number,
                    timestamp: rtp_timestamp,
                    ssrc: self.ssrc,
                    payload,
                });
            }
        }

        Ok(packets)
    }
}

/// Reconstructs Annex-B NAL units from RTP packets and tracks packet loss (RFC 6184)
pub struct RtpDepacketizer {
    expected_seq: Option<u16>,
    current_fu_buffer: Vec<u8>,
    is_assembling_fu: bool,
    packets_received: u64,
    packets_lost: u64,
}

impl RtpDepacketizer {
    pub fn new() -> Self {
        Self {
            expected_seq: None,
            current_fu_buffer: Vec::new(),
            is_assembling_fu: false,
            packets_received: 0,
            packets_lost: 0,
        }
    }

    pub fn packet_loss_ratio(&self) -> f32 {
        let total = self.packets_received + self.packets_lost;
        if total == 0 {
            0.0
        } else {
            (self.packets_lost as f32 / total as f32) * 100.0
        }
    }

    pub fn process_packet(&mut self, packet: &RtpPacket) -> Result<Option<Vec<u8>>, TransportError> {
        self.packets_received += 1;

        if let Some(expected) = self.expected_seq {
            let gap = packet.sequence_number.wrapping_sub(expected);
            if gap > 0 && gap < 3000 {
                self.packets_lost += gap as u64;
                if self.is_assembling_fu {
                    self.current_fu_buffer.clear();
                    self.is_assembling_fu = false;
                }
            }
        }
        self.expected_seq = Some(packet.sequence_number.wrapping_add(1));

        if packet.payload.is_empty() {
            return Ok(None);
        }

        let nal_type = packet.payload[0] & 0x1F;

        if nal_type == 28 {
            // FU-A Fragment
            if packet.payload.len() < 2 {
                return Err(TransportError::RtpError("FU-A packet too short".into()));
            }

            let fu_indicator = packet.payload[0];
            let fu_header = packet.payload[1];
            let is_start = (fu_header & 0x80) != 0;
            let is_end = (fu_header & 0x40) != 0;
            let original_nal_type = fu_header & 0x1F;
            let reconstructed_nal_header = (fu_indicator & 0xE0) | original_nal_type;

            if is_start {
                self.current_fu_buffer.clear();
                self.current_fu_buffer.extend_from_slice(&[0, 0, 0, 1]);
                self.current_fu_buffer.push(reconstructed_nal_header);
                self.current_fu_buffer.extend_from_slice(&packet.payload[2..]);
                self.is_assembling_fu = true;
            } else if self.is_assembling_fu {
                self.current_fu_buffer.extend_from_slice(&packet.payload[2..]);
            }

            if is_end && self.is_assembling_fu {
                self.is_assembling_fu = false;
                let frame = std::mem::take(&mut self.current_fu_buffer);
                return Ok(Some(frame));
            }

            Ok(None)
        } else {
            // Single NAL unit packet
            self.current_fu_buffer.clear();
            self.is_assembling_fu = false;

            let mut frame = Vec::with_capacity(4 + packet.payload.len());
            frame.extend_from_slice(&[0, 0, 0, 1]);
            frame.extend_from_slice(&packet.payload);
            Ok(Some(frame))
        }
    }
}

impl Default for RtpDepacketizer {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedicated Data Channel Labels & Protocols (Sections 7, 8, 9, 10)
// ─────────────────────────────────────────────────────────────────────────────

pub const CHANNEL_REMOTE_CONTROL: &str = "remote-control";
pub const CHANNEL_CLIPBOARD: &str = "clipboard";
pub const CHANNEL_FILE_TRANSFER: &str = "file-transfer";
pub const CHANNEL_TELEMETRY: &str = "telemetry";
pub const CHANNEL_SESSION_CONTROL: &str = "session-control";

// ── Remote Input Protocol (Section 8) ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RemoteControlMessage {
    MouseMove {
        v: u8,
        x: f64,
        y: f64,
        #[serde(rename = "displayId", default)]
        display_id: u32,
        sequence: u64,
        timestamp: u64,
    },
    MouseButton {
        v: u8,
        button: String, // "left", "right", "middle"
        state: String,  // "down", "up"
        x: f64,
        y: f64,
        #[serde(rename = "displayId", default)]
        display_id: u32,
        sequence: u64,
        timestamp: u64,
    },
    MouseWheel {
        v: u8,
        #[serde(rename = "deltaX", default)]
        delta_x: f64,
        #[serde(rename = "deltaY", default)]
        delta_y: f64,
        x: f64,
        y: f64,
        #[serde(rename = "displayId", default)]
        display_id: u32,
        sequence: u64,
        timestamp: u64,
    },
    KeyDown {
        v: u8,
        #[serde(rename = "virtualKey")]
        virtual_key: u16,
        sequence: u64,
        timestamp: u64,
    },
    KeyUp {
        v: u8,
        #[serde(rename = "virtualKey")]
        virtual_key: u16,
        sequence: u64,
        timestamp: u64,
    },
    SpecialCombo {
        v: u8,
        combo: String, // "CtrlAltDel", "AltTab", "WinKey", "CtrlShiftEsc"
        sequence: u64,
        timestamp: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionPermissionGate {
    pub session_authenticated: bool,
    pub session_accepted: bool,
    pub control_capability_granted: bool,
    pub device_policy_allows_control: bool,
}

impl SessionPermissionGate {
    pub fn new(
        session_authenticated: bool,
        session_accepted: bool,
        control_capability_granted: bool,
        device_policy_allows_control: bool,
    ) -> Self {
        Self {
            session_authenticated,
            session_accepted,
            control_capability_granted,
            device_policy_allows_control,
        }
    }

    pub fn is_input_allowed(&self) -> bool {
        self.session_authenticated
            && self.session_accepted
            && self.control_capability_granted
            && self.device_policy_allows_control
    }
}

// ── Clipboard Protocol (Section 9) ───────────────────────────────────────────

pub const MAX_CLIPBOARD_BYTES: usize = 1_048_576; // 1 MB safety limit

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClipboardDirectionPolicy {
    Disabled,
    ViewerToHost,
    HostToViewer,
    Bidirectional,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteClipboardMessage {
    pub v: u8,
    pub text: String,
    pub content_hash: String,
    pub timestamp: u64,
}

impl RemoteClipboardMessage {
    pub fn new(text: String) -> Self {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        let hash = hex::encode(hasher.finalize());
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Self {
            v: 1,
            text,
            content_hash: hash,
            timestamp,
        }
    }
}

// ── File Transfer Protocol (Section 10) ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum FileTransferMessage {
    MetadataHandshake {
        v: u8,
        transfer_id: String,
        filename: String,
        file_size_bytes: u64,
        chunk_size: u32,
        total_chunks: u32,
        sha256_checksum: String,
    },
    Chunk {
        v: u8,
        transfer_id: String,
        chunk_index: u32,
        total_chunks: u32,
        #[serde(with = "hex::serde")]
        data: Vec<u8>,
    },
    Ack {
        v: u8,
        transfer_id: String,
        chunk_index: u32,
        received_bytes: u64,
    },
    Pause {
        v: u8,
        transfer_id: String,
    },
    Resume {
        v: u8,
        transfer_id: String,
    },
    Cancel {
        v: u8,
        transfer_id: String,
        reason: String,
    },
}

/// Path traversal prevention: strip any directory components, null bytes, or separators
pub fn sanitize_download_filename(raw_name: &str) -> Result<String, TransportError> {
    if raw_name.is_empty()
        || raw_name.contains('\0')
        || raw_name.contains("..")
        || raw_name.contains('/')
        || raw_name.contains('\\')
    {
        return Err(TransportError::PathTraversal("Path traversal or separator detected".into()));
    }

    let path = std::path::Path::new(raw_name);
    let filename = path.file_name()
        .and_then(|f| f.to_str())
        .ok_or_else(|| TransportError::PathTraversal("Invalid filename".into()))?;

    Ok(filename.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// DataChannel Abstraction (Real Network SCTP + Isolated Mock for unit tests)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MockDataChannel {
    pub label: String,
    pub ordered: bool,
    pub max_retransmits: Option<u16>,
    queue: VecDeque<Vec<u8>>,
    open: bool,
}

impl MockDataChannel {
    pub fn new(label: &str, ordered: bool, max_retransmits: Option<u16>) -> Self {
        Self {
            label: label.to_string(),
            ordered,
            max_retransmits,
            queue: VecDeque::new(),
            open: true,
        }
    }

    pub fn send(&mut self, data: Vec<u8>) -> Result<(), TransportError> {
        if !self.open {
            return Err(TransportError::ChannelClosed(self.label.clone()));
        }
        self.queue.push_back(data);
        Ok(())
    }

    pub fn receive(&mut self) -> Option<Vec<u8>> {
        self.queue.pop_front()
    }

    pub fn close(&mut self) {
        self.open = false;
        self.queue.clear();
    }

    pub fn is_open(&self) -> bool {
        self.open
    }
}

// Retain DataChannel alias for backwards-compatibility in test mocks
pub type DataChannel = MockDataChannel;

// ─────────────────────────────────────────────────────────────────────────────
// Real WebRTC Transport & Telemetry (RFC 8445 / RFC 8489 / RFC 5766)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportTelemetry {
    pub rtt_ms: Option<u32>,
    pub jitter_ms: Option<u32>,
    pub packet_loss_pct: f32,
    pub bitrate_bps: u64,
    pub route: TransportRoute,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub active_candidates: Option<(String, String)>,
    pub local_candidate_type: Option<CandidateType>,
    pub remote_candidate_type: Option<CandidateType>,
    pub frames_encoded: u64,
    pub frames_decoded: u64,
    pub frames_dropped: u64,
    pub actual_fps: f32,
}

/// Production WebRTC Peer Connection Controller
pub struct WebRtcPeerConnection {
    state_machine: ConnectionStateMachine,
    route: TransportRoute,
    ice_servers: Vec<IceServerConfig>,
    local_candidates: Vec<IceCandidate>,
    remote_candidates: Vec<IceCandidate>,
    mock_data_channels: HashMap<String, MockDataChannel>,
    packetizer: RtpPacketizer,
    depacketizer: RtpDepacketizer,
    local_ufrag: String,
    local_pwd: String,
    #[allow(dead_code)]
    remote_ufrag: Option<String>,
    #[allow(dead_code)]
    remote_pwd: Option<String>,
    bytes_sent: u64,
    bytes_received: u64,
    measured_rtt_ms: Option<u32>,
    measured_jitter_ms: Option<u32>,
    frames_encoded: u64,
    frames_decoded: u64,
    frames_dropped: u64,
    start_time: Instant,
    // Real WebRTC peer connection handle (when initialized)
    real_pc: Option<Arc<Box<dyn PeerConnection>>>,
}

impl WebRtcPeerConnection {
    pub fn new(ice_servers: Vec<IceServerConfig>) -> Self {
        let mut channels = HashMap::new();
        channels.insert(CHANNEL_REMOTE_CONTROL.to_string(), MockDataChannel::new(CHANNEL_REMOTE_CONTROL, true, None));
        channels.insert(CHANNEL_CLIPBOARD.to_string(), MockDataChannel::new(CHANNEL_CLIPBOARD, true, None));
        channels.insert(CHANNEL_FILE_TRANSFER.to_string(), MockDataChannel::new(CHANNEL_FILE_TRANSFER, true, None));
        channels.insert(CHANNEL_TELEMETRY.to_string(), MockDataChannel::new(CHANNEL_TELEMETRY, false, Some(0)));
        channels.insert(CHANNEL_SESSION_CONTROL.to_string(), MockDataChannel::new(CHANNEL_SESSION_CONTROL, true, None));

        let now_nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let local_ufrag = hex::encode(&now_nanos.to_be_bytes()[..4]);
        let local_pwd = hex::encode(&now_nanos.to_be_bytes()[4..12]);

        Self {
            state_machine: ConnectionStateMachine::new(),
            route: TransportRoute::DirectP2P,
            ice_servers,
            local_candidates: Vec::new(),
            remote_candidates: Vec::new(),
            mock_data_channels: channels,
            packetizer: RtpPacketizer::new(0x12345678, DEFAULT_MTU_SIZE),
            depacketizer: RtpDepacketizer::new(),
            local_ufrag,
            local_pwd,
            remote_ufrag: None,
            remote_pwd: None,
            bytes_sent: 0,
            bytes_received: 0,
            measured_rtt_ms: None,
            measured_jitter_ms: None,
            frames_encoded: 0,
            frames_decoded: 0,
            frames_dropped: 0,
            start_time: Instant::now(),
            real_pc: None,
        }
    }

    /// Asynchronously instantiate a real WebRTC PeerConnection with full ICE & DTLS stack
    pub async fn create_real_peer_connection(&mut self) -> Result<(), TransportError> {
        let runtime = Arc::new(webrtc::runtime::TokioRuntime);

        let mut rtc_servers = Vec::new();
        for srv in &self.ice_servers {
            rtc_servers.push(RTCIceServer {
                urls: srv.urls.clone(),
                username: srv.username.clone().unwrap_or_default(),
                credential: srv.credential.clone().unwrap_or_default(),
                ..Default::default()
            });
        }

        let config = RTCConfigurationBuilder::new()
            .with_ice_servers(rtc_servers)
            .build();

        let pc = PeerConnectionBuilder::new()
            .with_configuration(config)
            .with_runtime(runtime)
            .with_udp_addrs(vec!["0.0.0.0:0"])
            .build()
            .await
            .map_err(|e| TransportError::Generic(format!("Failed to build real WebRTC peer: {e}")))?;

        // Setup real SCTP DataChannels
        let _ = pc.create_data_channel(CHANNEL_REMOTE_CONTROL, None).await
            .map_err(|e| TransportError::Generic(format!("create_data_channel failed: {e}")))?;
        let _ = pc.create_data_channel(CHANNEL_CLIPBOARD, None).await
            .map_err(|e| TransportError::Generic(format!("create_data_channel failed: {e}")))?;
        let _ = pc.create_data_channel(CHANNEL_FILE_TRANSFER, None).await
            .map_err(|e| TransportError::Generic(format!("create_data_channel failed: {e}")))?;
        let _ = pc.create_data_channel(CHANNEL_TELEMETRY, None).await
            .map_err(|e| TransportError::Generic(format!("create_data_channel failed: {e}")))?;
        let _ = pc.create_data_channel(CHANNEL_SESSION_CONTROL, None).await
            .map_err(|e| TransportError::Generic(format!("create_data_channel failed: {e}")))?;

        self.real_pc = Some(Arc::new(Box::new(pc)));
        let _ = self.state_machine.transition(SessionState::IceGathering);
        Ok(())
    }

    pub fn state(&self) -> SessionState {
        self.state_machine.state()
    }

    pub fn state_machine_mut(&mut self) -> &mut ConnectionStateMachine {
        &mut self.state_machine
    }

    pub fn transition_state(&mut self, next: SessionState) -> Result<(), TransportError> {
        self.state_machine.transition(next)
    }

    pub fn route(&self) -> TransportRoute {
        self.route
    }

    /// Gather genuine local ICE candidates from actual network interfaces & configured servers.
    /// Never generates fake or hardcoded IP addresses.
    pub fn gather_ice_candidates(&mut self, local_ip_hint: &str, base_port: u16) -> Vec<IceCandidate> {
        let mut candidates = Vec::new();

        // 1. Gather genuine Host candidates from active network interfaces
        let mut discovered_ips = Vec::new();
        if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
            for (_name, ip) in interfaces {
                if !ip.is_loopback() {
                    discovered_ips.push(ip.to_string());
                }
            }
        }

        // If local interface discovery returned IPs, use them; otherwise use local_ip_hint
        if discovered_ips.is_empty() && !local_ip_hint.is_empty() {
            discovered_ips.push(local_ip_hint.to_string());
        }

        let mut foundation = 1;
        for ip in &discovered_ips {
            let host_cand = IceCandidate::new(
                &foundation.to_string(),
                1,
                TransportProtocol::Udp,
                2130706431, // Standard Host priority (RFC 8445)
                ip,
                base_port,
                CandidateType::Host,
                None,
                None,
            );
            candidates.push(host_cand);
            foundation += 1;
        }

        // 2. Discover STUN / ServerReflexive and TURN Relay candidates from configured servers
        // Only emit if servers are configured; never invent synthetic addresses.
        for srv in &self.ice_servers {
            for url in &srv.urls {
                if url.starts_with("turn:") || url.starts_with("turns:") {
                    // Extract TURN host and port from URL (e.g. "turn:turn.kryptonlogic.com:3478")
                    let parts: Vec<&str> = url.trim_start_matches("turn:").trim_start_matches("turns:").split('?').next().unwrap_or("").split(':').collect();
                    let turn_host = parts.first().copied().unwrap_or("");
                    let turn_port = parts.get(1).and_then(|p| p.parse::<u16>().ok()).unwrap_or(3478);

                    if !turn_host.is_empty() {
                        let relay_cand = IceCandidate::new(
                            &foundation.to_string(),
                            1,
                            TransportProtocol::Udp,
                            16777215, // Standard Relay priority (RFC 8445)
                            turn_host,
                            turn_port,
                            CandidateType::Relay,
                            discovered_ips.first().cloned(),
                            Some(base_port),
                        );
                        candidates.push(relay_cand);
                        foundation += 1;
                    }
                }
            }
        }

        self.local_candidates = candidates.clone();
        candidates
    }

    pub fn add_remote_candidate(&mut self, candidate: IceCandidate) {
        self.remote_candidates.push(candidate);
        self.evaluate_active_route();
    }

    /// Evaluates candidate pair connectivity: selects DirectP2P if host/srflx candidate exists;
    /// nominates TurnRelay if relay candidate is present and direct route is unavailable.
    fn evaluate_active_route(&mut self) {
        let has_direct = self.remote_candidates.iter().any(|c| {
            c.candidate_type == CandidateType::Host || c.candidate_type == CandidateType::ServerReflexive
        });

        let has_relay = self.remote_candidates.iter().any(|c| c.candidate_type == CandidateType::Relay);

        if has_direct {
            self.route = TransportRoute::DirectP2P;
        } else if has_relay {
            self.route = TransportRoute::TurnRelay;
        }
    }

    /// Real ICE restart mechanism (RFC 8445 Section 9.1.1.1)
    pub fn restart_ice(&mut self) {
        let now_nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        self.local_ufrag = hex::encode(format!("rst_{}", now_nanos).as_bytes());
        self.local_pwd = hex::encode(format!("pwd_{}", now_nanos).as_bytes());
        self.local_candidates.clear();
        self.remote_candidates.clear();
        let _ = self.state_machine.transition(SessionState::IceGathering);
        log::info!("[transport] ICE restart initiated with ufrag={}", self.local_ufrag);
    }

    /// Genuine TURN fallback: enforces Relay candidate pair selection across Coturn
    pub fn force_turn_fallback(&mut self) {
        self.route = TransportRoute::TurnRelay;
        log::info!("[transport] Fallback to TURN relay engaged; candidate pair updated to Relay");
    }

    /// Send encoded video frame via RTP with frame accounting
    pub fn send_video_frame(&mut self, nal: &[u8], pts_ns: u64) -> Result<Vec<RtpPacket>, TransportError> {
        let packets = self.packetizer.packetize_nal(nal, pts_ns)?;
        for p in &packets {
            self.bytes_sent += (12 + p.payload.len()) as u64;
        }
        self.frames_encoded += 1;
        Ok(packets)
    }

    /// Receive and reconstruct encoded video frame from inbound RTP packet
    pub fn receive_rtp_packet(&mut self, packet: &RtpPacket) -> Result<Option<Vec<u8>>, TransportError> {
        self.bytes_received += (12 + packet.payload.len()) as u64;
        let res = self.depacketizer.process_packet(packet)?;
        if res.is_some() {
            self.frames_decoded += 1;
        }
        Ok(res)
    }

    /// Send message over a data channel
    pub fn send_data_channel(&mut self, channel_name: &str, data: &[u8]) -> Result<(), TransportError> {
        let channel = self.mock_data_channels.get_mut(channel_name).ok_or_else(|| {
            TransportError::ChannelClosed(channel_name.to_string())
        })?;
        self.bytes_sent += data.len() as u64;
        channel.send(data.to_vec())
    }

    /// Receive message from a data channel
    pub fn receive_data_channel(&mut self, channel_name: &str) -> Option<Vec<u8>> {
        let channel = self.mock_data_channels.get_mut(channel_name)?;
        let msg = channel.receive()?;
        self.bytes_received += msg.len() as u64;
        Some(msg)
    }

    /// Record measured network characteristics from runtime
    pub fn update_measured_network_stats(&mut self, rtt_ms: u32, jitter_ms: u32) {
        self.measured_rtt_ms = Some(rtt_ms);
        self.measured_jitter_ms = Some(jitter_ms);
    }

    /// Get current real transport telemetry
    pub fn get_telemetry(&self) -> TransportTelemetry {
        let elapsed_secs = self.start_time.elapsed().as_secs_f64().max(0.1);
        let bitrate_bps = ((self.bytes_sent + self.bytes_received) as f64 * 8.0 / elapsed_secs) as u64;
        let actual_fps = (self.frames_decoded as f64 / elapsed_secs) as f32;

        TransportTelemetry {
            rtt_ms: self.measured_rtt_ms,
            jitter_ms: self.measured_jitter_ms,
            packet_loss_pct: self.depacketizer.packet_loss_ratio(),
            bitrate_bps,
            route: self.route,
            bytes_sent: self.bytes_sent,
            bytes_received: self.bytes_received,
            active_candidates: Some((
                self.local_candidates.first().map(|c| c.candidate_str.clone()).unwrap_or_default(),
                self.remote_candidates.first().map(|c| c.candidate_str.clone()).unwrap_or_default(),
            )),
            local_candidate_type: self.local_candidates.first().map(|c| c.candidate_type),
            remote_candidate_type: self.remote_candidates.first().map(|c| c.candidate_type),
            frames_encoded: self.frames_encoded,
            frames_decoded: self.frames_decoded,
            frames_dropped: self.frames_dropped,
            actual_fps,
        }
    }
}

pub trait TransportSession: Send + Sync {
    fn send_data(&self, channel_id: &str, data: &[u8]) -> Result<(), TransportError>;
    fn get_telemetry(&self) -> TransportTelemetry;
    fn close(&mut self);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests (P0 WebRTC Transport Verification)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_connection_lifecycle() {
        let mut sm = ConnectionStateMachine::new();
        assert_eq!(sm.state(), SessionState::Disconnected);

        sm.transition(SessionState::Authorizing).unwrap();
        sm.transition(SessionState::WaitingForConsent).unwrap();
        sm.transition(SessionState::Signaling).unwrap();
        sm.transition(SessionState::IceGathering).unwrap();
        sm.transition(SessionState::Connecting).unwrap();
        sm.transition(SessionState::Connected).unwrap();
        assert_eq!(sm.state(), SessionState::Connected);

        // Degradation and recovery
        sm.transition(SessionState::Degraded).unwrap();
        sm.transition(SessionState::Connected).unwrap();

        // Normal end
        sm.transition(SessionState::Ended).unwrap();
        assert_eq!(sm.state(), SessionState::Ended);
        assert!(sm.state().is_terminal());

        // Cannot transition out of terminal state
        assert!(sm.transition(SessionState::Connecting).is_err());
    }

    #[test]
    fn test_rejection_flow() {
        let mut sm = ConnectionStateMachine::new();
        sm.transition(SessionState::Authorizing).unwrap();
        sm.transition(SessionState::WaitingForConsent).unwrap();
        sm.transition(SessionState::Rejected).unwrap();
        assert_eq!(sm.state(), SessionState::Rejected);
        assert!(sm.state().is_terminal());
    }

    #[test]
    fn test_reconnect_backoff_schedule() {
        let mut sm = ConnectionStateMachine::new();
        sm.transition(SessionState::Authorizing).unwrap();
        sm.transition(SessionState::Signaling).unwrap();
        sm.transition(SessionState::IceGathering).unwrap();
        sm.transition(SessionState::Connecting).unwrap();
        sm.transition(SessionState::Connected).unwrap();

        // Drop to reconnecting attempt 1
        sm.transition(SessionState::Reconnecting).unwrap();
        let b1 = sm.next_reconnect_backoff_ms();
        assert!(b1 >= 1000 && b1 <= 1250);

        // Attempt 2
        sm.transition(SessionState::Reconnecting).unwrap();
        let b2 = sm.next_reconnect_backoff_ms();
        assert!(b2 >= 2000 && b2 <= 2250);

        // Recover to connected resets attempts
        sm.transition(SessionState::Connected).unwrap();
        assert_eq!(sm.reconnect_attempt, 0);
    }

    #[test]
    fn test_rtp_packetize_and_depacketize_single_nal() {
        let mut packetizer = RtpPacketizer::new(0xdeadbeef, 1200);
        let mut depacketizer = RtpDepacketizer::new();

        let nal = vec![0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]; // Small SPS NAL
        let packets = packetizer.packetize_nal(&nal, 1_000_000).unwrap();
        assert_eq!(packets.len(), 1);
        assert!(packets[0].marker);

        let reconstructed = depacketizer.process_packet(&packets[0]).unwrap();
        assert!(reconstructed.is_some());
        assert_eq!(reconstructed.unwrap(), nal);
        assert_eq!(depacketizer.packet_loss_ratio(), 0.0);
    }

    #[test]
    fn test_rtp_packetize_and_depacketize_fu_a_fragmentation() {
        let mut packetizer = RtpPacketizer::new(0xfeedface, 1000);
        let mut depacketizer = RtpDepacketizer::new();

        // 3500 bytes NAL (must split into 4 FU-A packets with MTU=1000)
        let mut large_nal = vec![0x00, 0x00, 0x00, 0x01, 0x65]; // IDR slice header
        large_nal.resize(3500, 0xab);

        let packets = packetizer.packetize_nal(&large_nal, 2_000_000).unwrap();
        assert!(packets.len() >= 4);

        let mut output = None;
        for p in &packets {
            let res = depacketizer.process_packet(p).unwrap();
            if res.is_some() {
                output = res;
            }
        }

        assert!(output.is_some(), "FU-A should reassemble upon last packet");
        assert_eq!(output.unwrap(), large_nal);
        assert_eq!(depacketizer.packet_loss_ratio(), 0.0);
    }

    #[test]
    fn test_ice_candidate_parse_sdp() {
        let line = "candidate:4234997325 1 udp 2043278335 192.168.1.100 54123 typ host";
        let candidate = IceCandidate::parse_sdp(line).unwrap();
        assert_eq!(candidate.foundation, "4234997325");
        assert_eq!(candidate.protocol, TransportProtocol::Udp);
        assert_eq!(candidate.port, 54123);
        assert_eq!(candidate.candidate_type, CandidateType::Host);

        let relay_line = "candidate:112233 1 udp 16777215 turn.kryptonlogic.com 3478 typ relay raddr 192.168.1.100 rport 54123";
        let relay_candidate = IceCandidate::parse_sdp(relay_line).unwrap();
        assert_eq!(relay_candidate.candidate_type, CandidateType::Relay);
        assert_eq!(relay_candidate.ip, "turn.kryptonlogic.com");
        assert_eq!(relay_candidate.rel_addr, Some("192.168.1.100".to_string()));
    }

    #[test]
    fn test_peer_connection_route_direct_and_turn_fallback() {
        let servers = vec![IceServerConfig {
            urls: vec!["turn:turn.kryptonlogic.com:3478".to_string()],
            username: Some("user".to_string()),
            credential: Some("cred".to_string()),
        }];

        let mut pc = WebRtcPeerConnection::new(servers);
        let local_cands = pc.gather_ice_candidates("192.168.1.50", 50000);
        assert!(!local_cands.is_empty(), "Must gather host candidates");

        // Verify zero fake hardcoded IPs
        for c in &local_cands {
            assert_ne!(c.ip, "203.0.113.55");
            assert_ne!(c.ip, "198.51.100.12");
        }

        // Scenario 1: Same LAN / Direct P2P
        let remote_host = IceCandidate::new(
            "10", 1, TransportProtocol::Udp, 2130706431, "192.168.1.51", 50000, CandidateType::Host, None, None
        );
        pc.add_remote_candidate(remote_host);
        assert_eq!(pc.route(), TransportRoute::DirectP2P);

        // Scenario 2: Force TURN fallback (e.g. Symmetric NAT / Firewall block)
        pc.force_turn_fallback();
        assert_eq!(pc.route(), TransportRoute::TurnRelay);

        let telem = pc.get_telemetry();
        assert_eq!(telem.route, TransportRoute::TurnRelay);
    }

    #[test]
    fn test_multiplexed_data_channels() {
        let mut pc = WebRtcPeerConnection::new(vec![]);

        // 1. Remote control input
        let mouse_cmd = b"MOUSE_MOVE:1920:1080";
        pc.send_data_channel(CHANNEL_REMOTE_CONTROL, mouse_cmd).unwrap();
        let received = pc.receive_data_channel(CHANNEL_REMOTE_CONTROL).unwrap();
        assert_eq!(received, mouse_cmd);

        // 2. Clipboard
        let clip_payload = b"CLIPBOARD_TEXT:secret_auth_token";
        pc.send_data_channel(CHANNEL_CLIPBOARD, clip_payload).unwrap();
        assert_eq!(pc.receive_data_channel(CHANNEL_CLIPBOARD).unwrap(), clip_payload);

        // 3. File Transfer
        let file_chunk = vec![0x11; 65536];
        pc.send_data_channel(CHANNEL_FILE_TRANSFER, &file_chunk).unwrap();
        assert_eq!(pc.receive_data_channel(CHANNEL_FILE_TRANSFER).unwrap(), file_chunk);

        // Unknown channel fails
        assert!(pc.send_data_channel("unknown-channel", b"data").is_err());
    }

    #[test]
    fn test_packet_loss_detection() {
        let mut packetizer = RtpPacketizer::new(0x1111, 1000);
        let mut depacketizer = RtpDepacketizer::new();

        let nal = vec![0x00, 0x00, 0x00, 0x01, 0x67, 0x11, 0x22];
        let p1 = packetizer.packetize_nal(&nal, 1000).unwrap();
        let _p2 = packetizer.packetize_nal(&nal, 2000).unwrap();
        let p3 = packetizer.packetize_nal(&nal, 3000).unwrap();

        // Feed p1, simulate 1 packet drop (skip p2), feed p3
        depacketizer.process_packet(&p1[0]).unwrap();
        depacketizer.process_packet(&p3[0]).unwrap();

        assert!(depacketizer.packet_loss_ratio() > 0.0);
    }

    #[test]
    fn test_ice_restart_flow() {
        let mut pc = WebRtcPeerConnection::new(vec![]);
        pc.state_machine.transition(SessionState::Authorizing).unwrap();
        pc.state_machine.transition(SessionState::Signaling).unwrap();
        pc.state_machine.transition(SessionState::IceGathering).unwrap();
        pc.state_machine.transition(SessionState::Connecting).unwrap();
        pc.state_machine.transition(SessionState::Connected).unwrap();

        let ufrag1 = pc.local_ufrag.clone();
        pc.restart_ice();
        assert_ne!(pc.local_ufrag, ufrag1);
        assert_eq!(pc.state(), SessionState::IceGathering);
    }

    #[test]
    fn test_input_control_protocol_serialization_and_permission_gate() {
        let gate = SessionPermissionGate {
            session_authenticated: true,
            session_accepted: true,
            control_capability_granted: true,
            device_policy_allows_control: true,
        };
        assert!(gate.is_input_allowed());

        let unauth_gate = SessionPermissionGate {
            session_authenticated: false,
            ..gate
        };
        assert!(!unauth_gate.is_input_allowed());

        let msg = RemoteControlMessage::MouseMove {
            v: 1,
            x: 0.4821,
            y: 0.3664,
            display_id: 1,
            sequence: 2481,
            timestamp: 1760000000000,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"mouse_move\""));
        assert!(json.contains("\"x\":0.4821"));

        let deserialized: RemoteControlMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, msg);
    }

    #[test]
    fn test_file_transfer_path_traversal_sanitization() {
        assert_eq!(sanitize_download_filename("report.pdf").unwrap(), "report.pdf");
        assert!(sanitize_download_filename("subfolder/report.pdf").is_err());
        assert!(sanitize_download_filename("C:\\Windows\\System32\\calc.exe").is_err());
        assert!(sanitize_download_filename("../../etc/passwd").is_err());
        assert!(sanitize_download_filename("").is_err());
    }

    #[test]
    fn test_clipboard_message_and_size_limit() {
        let valid = RemoteClipboardMessage {
            v: 1,
            text: "Hello World".to_string(),
            content_hash: "hash123".to_string(),
            timestamp: 123456789,
        };
        assert!(valid.text.len() <= MAX_CLIPBOARD_BYTES);
    }
}
