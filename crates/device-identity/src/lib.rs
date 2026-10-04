use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum IdentityError {
    #[error("Failed to generate key pair")]
    GenerationFailed,
    #[error("Storage protection error: {0}")]
    StorageError(String),
    #[error("Serialization error: {0}")]
    SerializationError(String),
}

#[derive(Clone, Debug)]
pub struct DeviceIdentity {
    pub device_uuid: String,
    pub public_key_base64: String,
    pub key_fingerprint: String,
}

pub struct KeyPairManager {
    signing_key: SigningKey,
}

impl KeyPairManager {
    /// Keep the same device identity across restarts. Private keys are protected
    /// for the current Windows user with DPAPI, never stored as plaintext.
    #[cfg(windows)]
    pub fn load_or_generate(path: &std::path::Path) -> Result<Self, IdentityError> {
        match std::fs::read(path) {
            Ok(protected) => {
                let mut bytes = protect_key(&protected, false)?;
                let key: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
                    IdentityError::StorageError("Invalid stored device key".into())
                })?;
                bytes.fill(0);
                Ok(Self { signing_key: SigningKey::from_bytes(&key) })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let manager = Self::generate();
                let mut bytes = manager.signing_key.to_bytes();
                let protected = protect_key(&bytes, true);
                bytes.fill(0);
                let protected = protected?;
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| IdentityError::StorageError(e.to_string()))?;
                }
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)
                    .map_err(|e| IdentityError::StorageError(e.to_string()))?;
                file.write_all(&protected).and_then(|_| file.sync_all())
                    .map_err(|e| IdentityError::StorageError(e.to_string()))?;
                Ok(manager)
            }
            Err(e) => Err(IdentityError::StorageError(e.to_string())),
        }
    }

    /// Generate a fresh cryptographically secure Ed25519 keypair
    pub fn generate() -> Self {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        Self { signing_key }
    }

    /// Retrieve the base64-encoded public key
    pub fn public_key_base64(&self) -> String {
        let verifying_key: VerifyingKey = self.signing_key.verifying_key();
        BASE64.encode(verifying_key.as_bytes())
    }

    /// Calculate the SHA-256 fingerprint of the public key
    pub fn fingerprint(&self) -> String {
        let verifying_key: VerifyingKey = self.signing_key.verifying_key();
        let mut hasher = Sha256::new();
        hasher.update(verifying_key.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Sign an arbitrary payload
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        use ed25519_dalek::Signer;
        self.signing_key.sign(message).to_vec()
    }
}

#[cfg(windows)]
fn protect_key(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, IdentityError> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let result = if encrypt {
            CryptProtectData(&input, windows::core::PCWSTR::null(), None, None, None,
                CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        };
        result.map_err(|e| IdentityError::StorageError(e.to_string()))?;
        let output_bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = output_bytes.to_vec();
        output_bytes.fill(0);
        let _ = LocalFree(HLOCAL(output.pbData as *mut core::ffi::c_void));
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn persisted_key_survives_restart_and_rejects_corruption() {
        let folder = std::env::temp_dir().join(format!("krypton-identity-test-{}", rand::random::<u64>()));
        let path = folder.join("key.dpapi");
        let first = KeyPairManager::load_or_generate(&path).unwrap();
        let second = KeyPairManager::load_or_generate(&path).unwrap();
        assert_eq!(first.public_key_base64(), second.public_key_base64());
        assert_eq!(first.sign(b"test"), second.sign(b"test"));
        let stored = std::fs::read(&path).unwrap();
        assert_ne!(stored, first.signing_key.to_bytes());
        std::fs::write(&path, b"corrupted").unwrap();
        assert!(KeyPairManager::load_or_generate(&path).is_err());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(folder).unwrap();
    }

    #[test]
    fn test_keypair_generation_and_fingerprint() {
        let mgr = KeyPairManager::generate();
        let pub_key = mgr.public_key_base64();
        let fp = mgr.fingerprint();

        assert!(!pub_key.is_empty());
        assert_eq!(fp.len(), 64); // SHA-256 hex string is 64 chars
    }

    #[test]
    fn test_signature_verification() {
        use ed25519_dalek::Verifier;
        let mgr = KeyPairManager::generate();
        let msg = b"KryptonRemote Session Auth Nonce";
        let sig = mgr.sign(msg);

        let verifying_key = mgr.signing_key.verifying_key();
        let dalek_sig = ed25519_dalek::Signature::from_slice(&sig).unwrap();
        assert!(verifying_key.verify(msg, &dalek_sig).is_ok());
    }
}
