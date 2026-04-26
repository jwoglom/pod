# DASH vs Omnipod 5 Protocol Differences

This document describes the protocol differences between Omnipod DASH and Omnipod 5 (O5) based on reverse engineering analysis.

## Executive Summary

**The protocols are ~95% identical.** Both use the same TWi (TwInformation) protocol framework with the same message format, command structure, and encryption. The key differences are in the pairing phase.

---

## 1. Pairing / Key Exchange

### 1.1 Elliptic Curve

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **Curve** | Curve25519 (Montgomery) | P-256 / secp256r1 (NIST) |
| **Public Key Size** | 32 bytes | 64 bytes (uncompressed X,Y) |
| **Private Key Size** | 32 bytes | 32 bytes |
| **Library** | `golang.org/x/crypto/curve25519` | `crypto/ecdh` P256 |

**DASH Code (original):**
```go
import "golang.org/x/crypto/curve25519"
c.curve25519LTK, err = curve25519.X25519(c.podPrivate, c.pdmPublic)
```

**O5 Code (current):**
```go
import "crypto/ecdh"
privateKey, _ := ecdh.P256().NewPrivateKey(c.podPrivate)
publicKey, _ := ecdh.P256().NewPublicKey(append([]byte{0x04}, c.pdmPublic...))
c.sharedSecret, _ = privateKey.ECDH(publicKey)
```

### 1.2 Pairing Message Flow

| Stage | DASH | Omnipod 5 |
|-------|------|-----------|
| 1 | SP1/SP2 (IDs) | SP1/SP2 (IDs) |
| 2 | - | **SPS0** (new stage) |
| 3 | SPS1 (32B pub + 16B nonce) | SPS1 (64B pub + 16B nonce) |
| 4 | - | **SPS2.1** (extended data exchange) |
| 5 | SPS2 (confirmation) | SPS2 (confirmation) |
| 6 | SP0,GP0 | SP0,GP0 |
| 7 | P0 (0xa5) | P0 (0xa5) |

**SPS0 is NEW in O5** - PDM sends `0x00 0x01 0x09 0xa2 0x18`, pod replies with `0x00 0x00 0x09 0x91 0x29` (algorithm acceptance).

**SPS2.1 is NEW in O5** — AES-CCM-encrypted X.509 intermediate-CA cert exchanged before SPS2. SPS2 itself also changes shape in O5: it carries an encrypted TLS-leaf cert plus a 64-byte ECDSA signature over a 171-byte channel-binding transcript (see §1.5).
- PDM→Pod: ~651 bytes (signature + extracted public keys + metadata)
- Pod→PDM: ~650 bytes (signature + extracted public keys + metadata)
- Full X.509 certificates are **NOT** transmitted (pre-loaded in firmware/registration)
- Provides mutual PKI authentication proving possession of certificate private keys

### 1.3 Key Derivation (IDENTICAL)

Both DASH and O5 use the same CMAC-based key derivation:

```
firstKey = pod_public[-4:] + pdm_public[-4:] + pod_nonce[-4:] + pdm_nonce[-4:]
intermediaryKey = CMAC_AES(firstKey, sharedSecret)
confKey = CMAC_AES(intermediaryKey, 0x01 || "TWIt" || pod_nonce || pdm_nonce || 0x00 0x01)
LTK = CMAC_AES(intermediaryKey, 0x02 || "TWIt" || pod_nonce || pdm_nonce || 0x00 0x01)
pdmConf = CMAC_AES(confKey, "KC_2_U" || pdm_nonce || pod_nonce)
podConf = CMAC_AES(confKey, "KC_2_V" || pod_nonce || pdm_nonce)
```

### 1.4 Backend Nonce Retrieval (O5 Only)

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **PDM Nonce Source** | Generated locally | Retrieved from Insulet backend API |
| **Pod Nonce Source** | Generated locally | Generated locally |
| **Internet Required** | No | Yes (initial pairing only) |
| **Pairing Stages** | - | RetrievePdmNonceStage, RetrievePhoneControlNonceStage |

**Nonce Flow in Pairing:**
```
1. PDM retrieves nonce from Insulet backend (O5 only)
2. PDM sends: SPS1 = [64-byte public key] + [16-byte PDM nonce]
3. Pod generates: random 16-byte pod nonce
4. Pod sends: SPS1 = [64-byte public key] + [16-byte pod nonce]
5. Both parties derive keys using BOTH nonces
```

O5 has additional pairing stages that communicate with Insulet's cloud backend:
- `RetrievePdmNonceStage` - `GET /api/v3/provisioning/nonce`
- `RetrievePhoneControlNonceStage` - `POST /api/v3/provisioning/nonce` (nonce delivered via FCM push)
- `RetrievePdmPropertiesStage`
- `RegistrationStage`

**Impact on Simulator:** The backend nonces are **transparent to the pod**. The pod:
1. Generates its own random nonce (already implemented in `computeMyData()`)
2. Receives PDM's nonce from SPS1 message (doesn't care where it came from)
3. Uses both nonces for key derivation (already implemented)

The simulator works without any changes because it just accepts whatever nonce the PDM sends.

### 1.5 SPS2.1 and SPS2 — Cert + ECDSA Authentication (O5 Only)

**Authoritative source: OmnipodKit `O5LTKExchanger.swift` and `O5KeyExchange.swift`.** Earlier analyses in the BTSNOOP/Omnipod5APK side-docs describing SPS2.1 as a "compact proof" of stitched-together public keys are **incorrect** — SPS2.1 carries a single AES-CCM-encrypted X.509 certificate and SPS2 carries a cert plus an ECDSA signature.

#### Wire format

Both messages are AES-CCM(`conf` key, 13-byte SPS-nonce, 8-byte tag) over a plaintext payload. There is **no AAD**. The 16-byte `conf` key comes from the SHA-256 KDF in §1.4.

**SPS2.1 plaintext** = intermediate-CA cert DER (no signature here):
- PDM → pod: 634-byte cert + 8-byte tag = 642 bytes ciphertext
- pod → PDM: 633-byte cert + 8-byte tag = 641 bytes ciphertext

**SPS2 plaintext** = TLS-leaf cert DER ‖ raw 64-byte ECDSA r‖s signature:
- PDM → pod: ~1017-byte cert + 64-byte sig + 8-byte tag (size depends on the specific PDM's TLS cert)
- pod → PDM: same shape, pod's TLS cert + sig + tag

The signature inside SPS2 is over a **171-byte channel-binding transcript**:

```
PDM transcript (signs in this order):
  [0x01] || FIRMWARE_ID(6) || zeros(4) || pdmPub(64) || podPub(64) || pdmNonce(16) || podNonce(16)

Pod transcript (note swapped FIRMWARE_ID/zeros and keys/nonces grouped pod-first):
  [0x02] || zeros(4) || FIRMWARE_ID(6) || podPub(64) || pdmPub(64) || podNonce(16) || pdmNonce(16)
```

`FIRMWARE_ID = 9b0ab96a76f4`. Verification is `ecdsa.Verify(pubkey, sha256(transcript), r, s)` using the public key extracted from the cert in the same SPS2 message.

#### SPS-nonce (per-direction, with counter)

The 13-byte AES-CCM nonce for SPS2.1/SPS2 is direction-tagged:

```
write (PDM→pod):  [0x01] || pdmNonce[0:6] || podNonce[0:6]
read  (pod→PDM):  [0x02] || podNonce[0:6] || pdmNonce[0:6]
```

After each SPS message, the matching side's nonce is incremented by 1 by treating its first 8 bytes as a little-endian uint64 counter (the last 8 bytes are unchanged). See `pkg/pair/spsnonce.go` and OmnipodKit `O5KeyExchange.swift:138-162`.

#### Pod-side responsibilities (no chain validation needed)

OmnipodKit's `o5validatePodSps2_1` and `o5validatePodSps2` do **not** validate the cert chain back to a root. They only:
1. Decrypt the AES-CCM payload with `conf` and the read-direction SPS-nonce.
2. Call `extractP256PublicKey(fromDERCert:)` on the cert (a fixed-prefix scan for the SubjectPublicKeyInfo header).
3. Use that public key to verify the signature.

This means a pod simulator does **not** need a real INS00PG1/INS01PG1/INS02PG1-rooted chain. A single self-signed P-256 certificate wrapping the pod's signing public key is sufficient. Pod-five generates one on first activation and persists it (see `pkg/pair/podidentity.go`).

The pod also extracts the PDM's public key from the SPS2 cert and caches it (in `PODState.PDMPublicKey`) for verifying ECDSA signatures on post-pairing Type-4 commands (programBolus prime/cannula-insert and programBasal). See §6.1 below.

---

## 2. EAP-AKA Authentication

### 2.1 Core Protocol (IDENTICAL)

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **Protocol** | EAP-AKA (RFC 4187) | EAP-AKA (TwiEapAkaSlave) |
| **Algorithm** | Milenage | Milenage |
| **OP Constant** | `cdc202d5123e20f62b6d676ac72cb318` | Same |
| **AMF Value** | `0xb9b9` (47545) | Same |
| **AT_CUSTOM_IV** | Type 126 | Type 126 |

**Nonce Construction (O5/DASH):**
```
Nonce = PDM_IV (4B) || Pod_IV (4B) || Sequence (5B)
```

**EAP-AKA Exchange (O5/DASH):**
- EAP-Request/AKA-Challenge includes AT_RAND, AT_AUTN, AT_CUSTOM_IV (PDM IV).
- EAP-Response/AKA-Challenge includes AT_RES, AT_CUSTOM_IV (Pod IV).

### 2.2 Security Identifier (O5 Only - SDK Internal)

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **Security ID** | Not used | `0xCCCCCCCC` |
| **Usage** | - | TwiSec SDK internal caching |

The Security ID `0xCCCCCCCC` (bytes: -52, -52, -52, -52) is used by the TwiSec SDK for **internal context management and caching**, NOT for the actual AES-CCM cryptographic operations.

**Impact on Simulator**: Not needed. The actual encryption uses only CK + nonce, which the simulator already implements correctly.

### 2.3 IK (Integrity Key) Usage

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **IK from Milenage** | Computed but ignored | Not used in protocol |
| **Why unused?** | AES-CCM provides authentication | Same |

**Analysis**: In standard 3GPP EAP-AKA, IK is used for message integrity with HMAC/CMAC. However, Omnipod uses AES-CCM which provides both confidentiality AND authentication in a single operation. Therefore, IK is not needed.

The "CK + IK → LTK" interpretation is incorrect. The actual flow is:
1. **Pairing (Dash)**: ECDH shared secret → CMAC chain → LTK (stored permanently).
2. **Pairing (O5)**: ECDH shared secret → SHA-256 over a length-prefixed buffer that mixes a fixed 6-byte `FIRMWARE_ID = 9b0ab96a76f4` with both public keys → 32-byte digest split into `conf` (used during SPS2.1/SPS2 only) and `ltk` (used as the EAP-AKA pre-shared key). See `pkg/pair/o5kdf.go`.
3. **Session**: EAP-AKA with LTK as K → CK (used for encryption).

**Impact on Simulator**: IK can safely be ignored. CK alone is sufficient for AES-CCM.

---

## 3. Message Encryption (IDENTICAL)

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **Algorithm** | AES-CCM-128 | AES-CCM-128 |
| **Key** | CK from EAP-AKA | CK from EAP-AKA |
| **Nonce Length** | 13 bytes | 13 bytes |
| **Auth Tag** | 8 bytes | 8 bytes |
| **Associated Data** | 16-byte header | 16-byte header |
| **Direction Bit** | MSB of seq (0x80) | Same |

Nonce is composed as `PDM_IV || Pod_IV || sequence` (5-byte sequence counter).

---

## 4. BLE Communication (IDENTICAL)

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **Service UUID** | `1a7e4024-e3ed-4464-8b7e-751e03d0dc5f` | Same |
| **CMD Char** | `1a7e2441-e3ed-4464-8b7e-751e03d0dc5f` | Same |
| **DATA Char** | `1a7e2443-e3ed-4464-8b7e-751e03d0dc5f` | Same |
| **Control Char** | Not used | `1a7e2442-e3ed-4464-8b7e-751e03d0dc5f` |
| **Advertising** | "AP <ID> ..." | Same format |

O5 has an additional Control characteristic (`1a7e2442`) but its purpose is unclear from the decompiled code. The simulator works without it, suggesting it may be optional or used for advanced features not implemented in Loop.

**Impact on Simulator**: Not needed for basic operation.

**Initial Handshake (O5/DASH):** PDM sends CMD6 (`01 04 00 <PDM_ID>`) after GATT connection to announce its ID and begin pairing.

---

## 5. Message Format (IDENTICAL)

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **Magic Pattern** | "TW" | "TW" |
| **Header Size** | 16 bytes | 16 bytes |
| **Message Types** | 0-3 | 0-3 |
| **Command Prefix** | "S0.0=" | "S0.0=" |
| **Command Suffix** | ",G0.0" | ",G0.0" |
| **Sequence Numbers** | 4-bit (0-15) | 4-bit (0-15) |
| **CRC-32** | IEEE | IEEE |
| **CRC-16** | In commands | In commands |

---

## 6. Commands (IDENTICAL)

All command types are the same:

| ID | Command | Both |
|----|---------|------|
| 0x03 | SET_UNIQUE_ID | ✓ |
| 0x07 | GET_VERSION | ✓ |
| 0x0E | GET_STATUS | ✓ |
| 0x11 | SILENCE_ALERTS | ✓ |
| 0x13 | PROGRAM_BASAL | ✓ |
| 0x16 | PROGRAM_TEMP_BASAL | ✓ |
| 0x17 | PROGRAM_BOLUS | ✓ |
| 0x19 | PROGRAM_ALERTS | ✓ |
| 0x1A | PROGRAM_INSULIN | ✓ |
| 0x1C | DEACTIVATE | ✓ |
| 0x1E | PROGRAM_BEEPS | ✓ |
| 0x1F | STOP_DELIVERY | ✓ |

---

## 7. Summary of Differences

### Critical Differences:
1. **Elliptic Curve**: Curve25519 → P-256
2. **Public Key Size**: 32 bytes → 64 bytes
3. **KDF**: CMAC chain → SHA-256 over a length-prefixed buffer that mixes a fixed `FIRMWARE_ID` with the two public keys and the ECDH shared secret. Outputs a 16-byte `conf` (used for SPS2.1/SPS2 AES-CCM) and a 16-byte `ltk` (used as the EAP-AKA pre-shared key).
4. **SPS0 Stage**: Not present → Required (algorithm negotiation)
5. **SPS2.1 / SPS2 cert exchange**: Not present → AES-CCM-encrypted X.509 cert in SPS2.1, AES-CCM-encrypted cert + 64-byte ECDSA signature in SPS2 (signed over a 171-byte channel-binding transcript). See §1.5.
6. **Type-4 (ENCRYPTED_SIGNED) post-pairing commands**: Three commands — `programBolus(prime)`, `programBolus(cannula-insert)`, `programBasal` — carry a 64-byte ECDSA signature appended after the AES-CCM ciphertext. The signature is over `header(16B) || ciphertext-with-tag` and is verified using the PDM's public key extracted from its SPS2 cert. Only the controller→pod direction is signed; pod responses are plain Type-1.

### Minor Differences:
5. **Backend Nonces**: Local → API (transparent to pod)
6. **Security ID**: Not used → 0xCCCCCCCC (usage unclear)
7. **Control Characteristic**: Not used → May be used

### No Changes:
- Key derivation labels ("TWIt", "KC_2_U", "KC_2_V")
- EAP-AKA with Milenage
- AES-CCM encryption
- Message format
- BLE service/characteristic UUIDs
- All command types
- CRC algorithms

---

## 8. Simulator Status

Run mode is selected by `-mode dash|o5` (default `o5`). The Dash code paths are preserved behind `-mode dash` and follow the original CMAC KDF + plain-confirmation-value flow.

### Implemented (O5):
- ✅ P-256 ECDH and 64-byte public keys
- ✅ SPS0 algorithm negotiation
- ✅ SHA-256 KDF over `FIRMWARE_ID || zeros || pdmPub || podPub || sharedSecret` producing `conf` and `ltk` (`pkg/pair/o5kdf.go`)
- ✅ SPS2.1 cert exchange: AES-CCM(conf, 13-byte SPS-nonce, 8-byte tag) of an intermediate-CA cert DER, both directions (`pkg/pair/sps2.go`)
- ✅ SPS2 cert + ECDSA exchange: AES-CCM-encrypted `cert || raw-r||s` with `MessageType = 4` framing (`pkg/message/message.go`); pod signs the 171-byte channel-binding transcript
- ✅ Synthetic pod identity: per-pod self-signed P-256 cert + 32-byte private scalar generated on first activation and persisted in `state.toml` (`pkg/pair/podidentity.go`)
- ✅ PDM TLS-leaf pubkey extraction from SPS2 cert, cached in `PODState.PDMPublicKey` for post-pairing Type-4 verification
- ✅ EAP-AKA with Milenage and AUTN validation
- ✅ AES-CCM session encryption with direction-bit nonce
- ✅ O5 BLE advertising (`CE1F923D-…0AFFFFFFFE00` unpaired / `…0A<pdmId>00` paired) and heartbeat service `7DED7A6C-…` with characteristic `7DED7A6D-…` (notify, 10s)
- ✅ The 9 O5 AID Phase-1 setup commands (UTC/TDI/TargetBgProfile/DIA/EGV/AlgoInsulinHistory ×3/UnifiedAidPodStatus, plus setPodUid/programAlert/programBolus(prime) that follow) using OmnipodKit's plain-ASCII key=value protocol — see `pkg/aid/`
- ✅ Type-4 inbound signature verification on `programBolus(prime/cannula-insert)` and `programBasal` (`pair.VerifyType4Signature`)
- ✅ Pulse-by-pulse bolus delivery: status responses interpolate `Reservoir`/`Delivered` based on elapsed time vs `BolusEnd`; cancellation locks in partial delivery (`pkg/pod/delivery/`)

### Known not-implemented:
- ⚠️ Real basal-schedule modeling — pod-five only flips a `BasalActive` flag; the 48-half-hour rate table from PROGRAM_INSULIN(table 0) is not parsed or evaluated per-minute. Cosmetic for OmnipodKit since basal output isn't reflected in StatusResponse delivered/reservoir fields anyway.
- ⚠️ Stock Insulet-app behaviours not on the OmnipodKit compatibility path: L2CAP CoC switchover, pod-initiated unsolicited commands after automated-mode toggles, full Eros/Dash multi-platform fragmentation tuning. Skipping these is intentional — OmnipodKit doesn't use them and would desync if pod-five sent them.

### Verification:
- Go unit tests: `go test ./pkg/pair/ ./pkg/message/ ./pkg/aid/ ./pkg/eap/ ./pkg/pod/delivery/ ./pkg/testfixtures/` — covers KDF input layout, SPS-nonce build/increment, SPS2.1 round-trip, SPS2 round-trip with full ECDSA sign+verify, Type-4 signature verify with tamper rejection, AID command parse/encode/respond round-trip, Type-4 message Marshal/Unmarshal, pulse-progress math, and EAP-AKA marshal/unmarshal.
- Captures: `pkg/testfixtures/` embeds three real-pod pairing sessions from `Omnipod5APK/BTSNOOP/` (3 SPS1 sets + 7 SPS2.1/SPS2 ciphertexts) for use in future replay-style tests.
- Smoke test (out-of-band): pair, activate, bolus, deactivate using a patched OmnipodKit on a real iPhone against pod-five running on a Pi. OmnipodKit needs a build with its own registration data populated (`O5RegistrationData`); no other patch is needed because OmnipodKit's pod-cert verification is soft-fail and chain validation is not performed.

---

## 9. Additional Resources

**Authoritative reference (used as ground-truth for this doc):**
- **`../OmnipodKit/OmnipodKit/Bluetooth/Pair/O5LTKExchanger.swift`** — full controller-side O5 pairing flow (SPS0 → SPS2 → P0).
- **`../OmnipodKit/OmnipodKit/Bluetooth/Pair/O5KeyExchange.swift`** — KDF, SPS-nonce, channel-binding transcripts.
- **`../OmnipodKit/OmnipodKit/Bluetooth/Pair/O5CertificateStore.swift`** — pubkey extraction from DER and signature verification.
- **`../OmnipodKit/OmnipodKit/Bluetooth/BleMessageTransport.swift`** — Type-1 vs Type-4 framing and the AID command transport.
- **`../OmnipodKit/OmnipodKit/Bluetooth/O5AidCommands.swift`** — exact ASCII formats for the 9 AID setup commands.

**Capture data (use as fixtures, not as a spec):**
- **`../Omnipod5APK/BTSNOOP/`** — real-pod btsnoop captures plus `extract_sps_payloads.py` / `decode_btsnoop.py`. Embedded into `pkg/testfixtures/` for tests.

**Speculative side-docs (predate the OmnipodKit reference and contain inaccuracies):**
- `../Omnipod5APK/POD_PKI.md`, `../Omnipod5APK/BTSNOOP/BTSNOOP_ANALYSIS.md`, `../o5control/SPS21_ANALYSIS.md`. The "compact proof of stitched public keys" SPS2.1 description in these files is **wrong**; SPS2.1 carries an AES-CCM-encrypted X.509 cert. When these docs disagree with OmnipodKit, OmnipodKit wins.

---

*Document generated from reverse engineering analysis of Omnipod5APK and pod simulator codebase.*
