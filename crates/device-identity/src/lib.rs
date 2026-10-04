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

#[cfg(test)]
mod tests {
    use super::*;

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
