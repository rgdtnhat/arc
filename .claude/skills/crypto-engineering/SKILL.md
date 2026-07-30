---
name: crypto-engineering
description: Cryptographic engineering discipline and quantum-transition guidance — never roll your own crypto at any layer, AEAD-or-nothing with strict nonce discipline, Argon2id for passwords and CSPRNG for tokens, constant-time comparisons, key management as the real problem, crypto-agility, and post-quantum migration (harvest-now-decrypt-later, hybrid ML-KEM key exchange, Mosca's inequality). Use whenever implementing or reviewing ANYTHING touching encryption, hashing, passwords, tokens, sessions, signing, certificates, TLS, JWTs, key storage or rotation, random generation for security purposes — even a "simple" password reset or API-key feature — and whenever quantum computing's impact on security comes up. Verify named standards against current NIST/IETF sources; this skill has a knowledge cutoff.
---

# Crypto Engineering

Cryptography is the domain where almost-right is indistinguishable from broken until the day it isn't. Full rationale in [CRYPTO_QUANTUM.md](../../../CRYPTO_QUANTUM.md). **Calibration: standards below are a January 2026 snapshot — verify against current NIST/IETF publications before acting on specifics.**

## Never roll your own — at any layer
Not primitives, not protocols, not compositions, not parameter choices. The violations that ship are one layer up from AES: hand-rolled token formats, custom handshakes, DIY IV handling. Use misuse-resistant tools (libsodium, age, TLS, standard PASETO/JWT libraries) and prefer APIs that make the wrong call impossible. A `crypto_utils` file containing anything beyond calls into a vetted library is the smell.

## AEAD or nothing
Unauthenticated encryption is broken, not weaker: bit-flipping, padding oracles, forgery. Use AES-GCM / ChaCha20-Poly1305 everywhere, including "internal" data. Nonce reuse under one key is catastrophic (GCM leaks its auth key) — treat nonce discipline as a hard invariant; prefer counters or XChaCha's extended nonces over random 96-bit nonces at scale.

## Passwords, tokens, randomness
Passwords: Argon2id (or scrypt), unique salt each, never fast hashes, never reversible. Tokens/keys/session IDs: OS CSPRNG only (`secrets`, `crypto.randomBytes`) — never `random()`, timestamps, or predictable IDs. Compare secrets with constant-time functions (`hmac.compare_digest`, `crypto.timingSafeEqual`), never `==`.

## Key management is the actual problem
Keys live in a vault/KMS, never in code or config (see agent-security). One key, one purpose; rotation designed in from day one; every key has an answer to "who can read this and what happens when it leaks?" Algorithms rarely fail in practice — key handling fails constantly.

## Crypto-agility
Every algorithm dies within a career (MD5, SHA-1, RC4, 1024-bit RSA). Version every ciphertext and token format; centralize algorithm choices in one module; make protocols negotiate. The swap must be a rollout, not an archaeology project.

## The quantum transition
- **Two algorithms matter.** Shor breaks RSA/ECC/DH outright (needs a large fault-tolerant machine that doesn't exist yet — but estimates keep falling). Grover halves symmetric strength: fix is AES-256 + SHA-256/SHA-3, done. Asymmetric crypto is the casualty; symmetric survives with bigger keys.
- **The live threat is harvest-now-decrypt-later**: adversaries record ciphertext today, decrypt when hardware arrives. Apply Mosca's inequality — if data-secrecy-years + migration-years > years-to-quantum, you're already late. Long-lived secrets need post-quantum key exchange *now*.
- **PQC is standardized**: NIST FIPS 203 (ML-KEM) for key exchange, FIPS 204 (ML-DSA) / FIPS 205 (SLH-DSA) for signatures — verify current status. Deploy **hybrid** first (X25519+ML-KEM, as major browsers ship). Migrate key exchange before signatures; budget for bigger keys and ciphertexts.
- **Quantum-safe ≠ quantum-flavored**: QKD and "quantum RNGs" are mostly not the answer; PQC (ordinary math on ordinary computers) is. Prefer NIST over anything with a laser in the sales deck.

## The consolidation
Vetted library, authenticate everything, guard keys like they're the whole system (they are), version for the day the algorithm dies, and migrate on the schedule your *data* demands — then re-verify against living standards.
