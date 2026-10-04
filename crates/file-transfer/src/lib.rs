use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const DEFAULT_CHUNK_SIZE: usize = 64 * 1024; // 64 KB

#[derive(Error, Debug, PartialEq, Eq)]
pub enum FileTransferError {
    #[error("Path traversal security violation: illegal destination path")]
    PathTraversalDetected,
    #[error("Checksum mismatch: expected {expected}, actual {actual}")]
    ChecksumMismatch { expected: String, actual: String },
    #[error("IO error: {0}")]
    IoError(String),
    #[error("Invalid chunk index {chunk_index} for total chunks {total_chunks}")]
    InvalidChunkIndex { chunk_index: u32, total_chunks: u32 },
    #[error("Transfer is not in an active state (current: {0:?})")]
    InvalidState(TransferState),
    #[error("Transfer ID mismatch: expected {expected}, actual {actual}")]
    TransferIdMismatch { expected: String, actual: String },
    #[error("File transfer permission denied by host")]
    PermissionDenied,
}

impl From<std::io::Error> for FileTransferError {
    fn from(err: std::io::Error) -> Self {
        FileTransferError::IoError(err.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransferState {
    Queued,
    Negotiating,
    Transferring,
    Paused,
    Verifying,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferMetadata {
    pub transfer_id: String,
    pub filename: String,
    pub file_size_bytes: u64,
    pub chunk_size: usize,
    pub total_chunks: u32,
    pub sha256_checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileChunk {
    pub transfer_id: String,
    pub chunk_index: u32,
    pub total_chunks: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileTransferAck {
    pub transfer_id: String,
    pub chunk_index: u32,
    pub received_bytes: u64,
    pub state: TransferState,
}

pub struct TransferVerifier {
    hasher: Sha256,
}

impl TransferVerifier {
    pub fn new() -> Self {
        Self { hasher: Sha256::new() }
    }

    pub fn update(&mut self, chunk: &[u8]) {
        self.hasher.update(chunk);
    }

    pub fn finalize_and_verify(self, expected_hex: &str) -> Result<(), FileTransferError> {
        let actual = hex::encode(self.hasher.finalize());
        if actual.eq_ignore_ascii_case(expected_hex) {
            Ok(())
        } else {
            Err(FileTransferError::ChecksumMismatch {
                expected: expected_hex.to_string(),
                actual,
            })
        }
    }
}

/// Validates that a requested filename or relative path contains no directory traversal
pub fn sanitize_destination_path(base_dir: &Path, user_provided_filename: &str) -> Result<PathBuf, FileTransferError> {
    if user_provided_filename.contains("..")
        || user_provided_filename.contains(':')
        || user_provided_filename.starts_with('/')
        || user_provided_filename.starts_with('\\')
    {
        return Err(FileTransferError::PathTraversalDetected);
    }

    // Strip leading path components to ensure it remains purely a local filename
    let clean_name = Path::new(user_provided_filename)
        .file_name()
        .ok_or(FileTransferError::PathTraversalDetected)?;

    let target = base_dir.join(clean_name);
    Ok(target)
}

/// Compute SHA-256 hash of a file on disk
pub fn compute_file_sha256(path: &Path) -> Result<String, FileTransferError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }

    Ok(hex::encode(hasher.finalize()))
}

// ─────────────────────────────────────────────────────────────────────────────
// FileTransferReceiver — handles inbound chunk assembly & verification
// ─────────────────────────────────────────────────────────────────────────────

pub struct FileTransferReceiver {
    metadata: TransferMetadata,
    destination_path: PathBuf,
    staging_path: PathBuf,
    received_chunks: BTreeSet<u32>,
    received_bytes: u64,
    state: TransferState,
}

impl FileTransferReceiver {
    pub fn new(metadata: TransferMetadata, base_staging_dir: &Path) -> Result<Self, FileTransferError> {
        fs::create_dir_all(base_staging_dir)?;
        let destination_path = sanitize_destination_path(base_staging_dir, &metadata.filename)?;
        let staging_filename = format!("{}.kpart", metadata.transfer_id);
        let staging_path = base_staging_dir.join(staging_filename);

        Ok(Self {
            metadata,
            destination_path,
            staging_path,
            received_chunks: BTreeSet::new(),
            received_bytes: 0,
            state: TransferState::Transferring,
        })
    }

    pub fn metadata(&self) -> &TransferMetadata {
        &self.metadata
    }

    pub fn state(&self) -> TransferState {
        self.state
    }

    pub fn received_bytes(&self) -> u64 {
        self.received_bytes
    }

    pub fn received_chunks_count(&self) -> usize {
        self.received_chunks.len()
    }

    pub fn is_chunk_received(&self, chunk_index: u32) -> bool {
        self.received_chunks.contains(&chunk_index)
    }

    pub fn missing_chunks(&self) -> Vec<u32> {
        (0..self.metadata.total_chunks)
            .filter(|idx| !self.received_chunks.contains(idx))
            .collect()
    }

    pub fn receive_chunk(&mut self, chunk: &FileChunk) -> Result<FileTransferAck, FileTransferError> {
        if self.state != TransferState::Transferring {
            return Err(FileTransferError::InvalidState(self.state));
        }

        if chunk.transfer_id != self.metadata.transfer_id {
            return Err(FileTransferError::TransferIdMismatch {
                expected: self.metadata.transfer_id.clone(),
                actual: chunk.transfer_id.clone(),
            });
        }

        if chunk.chunk_index >= self.metadata.total_chunks {
            return Err(FileTransferError::InvalidChunkIndex {
                chunk_index: chunk.chunk_index,
                total_chunks: self.metadata.total_chunks,
            });
        }

        // Only write if not already received (idempotent chunk processing)
        if !self.received_chunks.contains(&chunk.chunk_index) {
            let offset = (chunk.chunk_index as u64) * (self.metadata.chunk_size as u64);
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .open(&self.staging_path)?;

            file.seek(SeekFrom::Start(offset))?;
            file.write_all(&chunk.data)?;

            self.received_chunks.insert(chunk.chunk_index);
            self.received_bytes += chunk.data.len() as u64;
        }

        // Check if all chunks received
        if self.received_chunks.len() == self.metadata.total_chunks as usize {
            self.state = TransferState::Verifying;
            self.finalize_verification()?;
        }

        Ok(FileTransferAck {
            transfer_id: self.metadata.transfer_id.clone(),
            chunk_index: chunk.chunk_index,
            received_bytes: self.received_bytes,
            state: self.state,
        })
    }

    fn finalize_verification(&mut self) -> Result<(), FileTransferError> {
        // Compute SHA-256 of the completed staging file
        let computed_hash = match compute_file_sha256(&self.staging_path) {
            Ok(h) => h,
            Err(e) => {
                self.state = TransferState::Failed;
                return Err(e);
            }
        };

        if computed_hash.eq_ignore_ascii_case(&self.metadata.sha256_checksum) {
            // Atomic rename from staging to destination path
            if let Err(e) = fs::rename(&self.staging_path, &self.destination_path) {
                self.state = TransferState::Failed;
                return Err(FileTransferError::IoError(e.to_string()));
            }
            self.state = TransferState::Completed;
            Ok(())
        } else {
            self.state = TransferState::Failed;
            // Clean up corrupted staging file
            let _ = fs::remove_file(&self.staging_path);
            Err(FileTransferError::ChecksumMismatch {
                expected: self.metadata.sha256_checksum.clone(),
                actual: computed_hash,
            })
        }
    }

    pub fn cancel(&mut self) {
        self.state = TransferState::Cancelled;
        let _ = fs::remove_file(&self.staging_path);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FileTransferSender — handles outbound chunk reading & progress tracking
// ─────────────────────────────────────────────────────────────────────────────

pub struct FileTransferSender {
    metadata: TransferMetadata,
    source_path: PathBuf,
    acknowledged_chunks: BTreeSet<u32>,
    state: TransferState,
}

impl FileTransferSender {
    pub fn new(source_path: PathBuf, transfer_id: String) -> Result<Self, FileTransferError> {
        if !source_path.is_file() {
            return Err(FileTransferError::IoError(format!(
                "Source path does not exist or is not a file: {}",
                source_path.display()
            )));
        }

        let file_size_bytes = fs::metadata(&source_path)?.len();
        let filename = source_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unnamed_file")
            .to_string();

        let sha256_checksum = compute_file_sha256(&source_path)?;
        let chunk_size = DEFAULT_CHUNK_SIZE;
        let total_chunks = if file_size_bytes == 0 {
            1
        } else {
            ((file_size_bytes + chunk_size as u64 - 1) / chunk_size as u64) as u32
        };

        let metadata = TransferMetadata {
            transfer_id,
            filename,
            file_size_bytes,
            chunk_size,
            total_chunks,
            sha256_checksum,
        };

        Ok(Self {
            metadata,
            source_path,
            acknowledged_chunks: BTreeSet::new(),
            state: TransferState::Transferring,
        })
    }

    pub fn metadata(&self) -> &TransferMetadata {
        &self.metadata
    }

    pub fn state(&self) -> TransferState {
        self.state
    }

    pub fn get_chunk(&self, chunk_index: u32) -> Result<FileChunk, FileTransferError> {
        if chunk_index >= self.metadata.total_chunks {
            return Err(FileTransferError::InvalidChunkIndex {
                chunk_index,
                total_chunks: self.metadata.total_chunks,
            });
        }

        let offset = (chunk_index as u64) * (self.metadata.chunk_size as u64);
        let mut file = File::open(&self.source_path)?;
        file.seek(SeekFrom::Start(offset))?;

        let remaining = self.metadata.file_size_bytes.saturating_sub(offset);
        let read_size = (self.metadata.chunk_size as u64).min(remaining) as usize;

        let mut data = vec![0u8; read_size];
        file.read_exact(&mut data)?;

        Ok(FileChunk {
            transfer_id: self.metadata.transfer_id.clone(),
            chunk_index,
            total_chunks: self.metadata.total_chunks,
            data,
        })
    }

    pub fn acknowledge_chunk(&mut self, chunk_index: u32) -> TransferState {
        self.acknowledged_chunks.insert(chunk_index);
        if self.acknowledged_chunks.len() == self.metadata.total_chunks as usize {
            self.state = TransferState::Completed;
        }
        self.state
    }

    pub fn is_completed(&self) -> bool {
        self.acknowledged_chunks.len() == self.metadata.total_chunks as usize
    }

    pub fn missing_chunks(&self) -> Vec<u32> {
        (0..self.metadata.total_chunks)
            .filter(|idx| !self.acknowledged_chunks.contains(idx))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_traversal_protection() {
        let base = Path::new("C:\\Users\\Krypton\\Downloads");

        // Malicious attempts
        assert!(sanitize_destination_path(base, "../../../Windows/System32/calc.exe").is_err());
        assert!(sanitize_destination_path(base, "C:\\autoexec.bat").is_err());
        assert!(sanitize_destination_path(base, "/etc/passwd").is_err());

        // Safe filename
        let safe = sanitize_destination_path(base, "report.pdf").unwrap();
        assert_eq!(safe, base.join("report.pdf"));
    }

    #[test]
    fn test_transfer_checksum_verification() {
        let mut verifier = TransferVerifier::new();
        let chunk1 = b"Hello, ";
        let chunk2 = b"KryptonRemote File Transfer!";
        verifier.update(chunk1);
        verifier.update(chunk2);

        // Precalculated SHA256 of "Hello, KryptonRemote File Transfer!"
        let mut h = Sha256::new();
        h.update(b"Hello, KryptonRemote File Transfer!");
        let expected = hex::encode(h.finalize());

        assert!(verifier.finalize_and_verify(&expected).is_ok());
    }

    #[test]
    fn test_end_to_end_resumable_file_transfer() {
        let temp_dir = std::env::temp_dir().join(format!("krypton_test_transfer_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let staging_dir = temp_dir.join("staging");
        let dest_dir = temp_dir.join("dest");
        fs::create_dir_all(&staging_dir).unwrap();
        fs::create_dir_all(&dest_dir).unwrap();

        // 1. Create a sample 180 KB file (requires 3 chunks with 64KB chunk size)
        let source_file = temp_dir.join("sample_doc.bin");
        let sample_data: Vec<u8> = (0..(180 * 1024)).map(|i| (i % 256) as u8).collect();
        fs::write(&source_file, &sample_data).unwrap();

        // 2. Sender creates metadata
        let mut sender = FileTransferSender::new(source_file.clone(), "transfer-xyz-123".to_string()).unwrap();
        assert_eq!(sender.metadata().total_chunks, 3);
        assert_eq!(sender.metadata().file_size_bytes, 180 * 1024);

        // 3. Receiver initializes session
        let mut receiver = FileTransferReceiver::new(sender.metadata().clone(), &dest_dir).unwrap();
        assert_eq!(receiver.missing_chunks(), vec![0, 1, 2]);

        // 4. Send chunk 0
        let chunk0 = sender.get_chunk(0).unwrap();
        let ack0 = receiver.receive_chunk(&chunk0).unwrap();
        sender.acknowledge_chunk(0);
        assert_eq!(ack0.state, TransferState::Transferring);
        assert_eq!(receiver.missing_chunks(), vec![1, 2]);

        // 5. Send chunk 2 out of order (resumable / out-of-order test)
        let chunk2 = sender.get_chunk(2).unwrap();
        let ack2 = receiver.receive_chunk(&chunk2).unwrap();
        sender.acknowledge_chunk(2);
        assert_eq!(ack2.state, TransferState::Transferring);
        assert_eq!(receiver.missing_chunks(), vec![1]);

        // 6. Send missing chunk 1 to complete transfer
        let chunk1 = sender.get_chunk(1).unwrap();
        let ack1 = receiver.receive_chunk(&chunk1).unwrap();
        sender.acknowledge_chunk(1);
        assert_eq!(ack1.state, TransferState::Completed);
        assert_eq!(receiver.state(), TransferState::Completed);
        assert!(sender.is_completed());

        // 7. Verify received destination file on disk
        let final_dest = dest_dir.join("sample_doc.bin");
        assert!(final_dest.exists(), "Final destination file must exist after atomic rename");
        let read_back = fs::read(&final_dest).unwrap();
        assert_eq!(read_back.len(), sample_data.len());
        assert_eq!(read_back, sample_data);

        // Clean up
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_corrupted_chunk_fails_verification() {
        let temp_dir = std::env::temp_dir().join(format!("krypton_test_corrupt_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&temp_dir).unwrap();

        let source_file = temp_dir.join("good_doc.txt");
        fs::write(&source_file, b"Original Uncorrupted Content").unwrap();

        let sender = FileTransferSender::new(source_file, "transfer-corrupt-test".to_string()).unwrap();
        let mut receiver = FileTransferReceiver::new(sender.metadata().clone(), &temp_dir).unwrap();

        // Tamper with chunk data
        let mut corrupted_chunk = sender.get_chunk(0).unwrap();
        corrupted_chunk.data[0] ^= 0xFF; // flip bits

        let result = receiver.receive_chunk(&corrupted_chunk);
        assert!(result.is_err(), "Must reject corrupted chunk at verification stage");
        assert_eq!(receiver.state(), TransferState::Failed);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
