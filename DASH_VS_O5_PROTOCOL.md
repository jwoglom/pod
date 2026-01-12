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
| 4 | SPS2 (confirmation) | SPS2 (confirmation) |
| 5 | SP0,GP0 | SP0,GP0 |
| 6 | P0 (0xa5) | P0 (0xa5) |

**SPS0 is NEW in O5** - Contains constant value `0x00 0x00 0x09 0x91 0x29`

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
| **Nonce Source** | Generated locally | Retrieved from Insulet backend API |
| **Internet Required** | No | Yes (initial pairing only) |
| **Pairing Stages** | - | RetrievePdmNonceStage, RetrievePhoneControlNonceStage |

O5 has additional pairing stages that communicate with Insulet's cloud backend:
- `RetrievePdmNonceStage` - GET /api/nonce
- `RetrievePhoneControlNonceStage` - GET /api/phone/nonce
- `RetrievePdmPropertiesStage`
- `RegistrationStage`

**Impact on Simulator:** The simulator generates nonces locally, which should work fine since the pod doesn't validate nonce source.

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

### 2.2 Security Identifier (O5 Only)

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **Security ID** | Not used | `0xCCCCCCCC` |
| **Usage** | - | Passed to TwiCcmAes.initCcm() |

The Security ID `0xCCCCCCCC` (bytes: -52, -52, -52, -52) is used in O5 when initializing the TwiCcmAes encryption engine. Purpose unclear - may be a product identifier.

### 2.3 IK (Integrity Key) Usage

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **IK from Milenage** | Computed but ignored | May be used |
| **LTK derivation** | From pairing ECDH | Possibly CK + IK? |

The O5 documentation mentions "CK + IK → LTK" but the exact derivation needs verification. The simulator currently ignores IK.

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

---

## 4. BLE Communication (IDENTICAL)

| Aspect | DASH | Omnipod 5 |
|--------|------|-----------|
| **Service UUID** | `1a7e4024-e3ed-4464-8b7e-751e03d0dc5f` | Same |
| **CMD Char** | `1a7e2441-e3ed-4464-8b7e-751e03d0dc5f` | Same |
| **DATA Char** | `1a7e2443-e3ed-4464-8b7e-751e03d0dc5f` | Same |
| **Control Char** | Not used | `1a7e2442-e3ed-4464-8b7e-751e03d0dc5f` |
| **Advertising** | "AP <ID> ..." | Same format |

O5 has an additional Control characteristic (`1a7e2442`) but its usage is unclear.

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
3. **SPS0 Stage**: Not present → Required

### Minor Differences:
4. **Backend Nonces**: Local → API (transparent to pod)
5. **Security ID**: Not used → 0xCCCCCCCC (usage unclear)
6. **Control Characteristic**: Not used → May be used
7. **IK Usage**: Ignored → Possibly used

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

The pod simulator has already been updated for O5:
- ✅ P-256 curve implemented
- ✅ SPS0 stage implemented
- ✅ 64-byte public keys
- ✅ EAP-AKA with Milenage
- ✅ AES-CCM encryption
- ✅ Correct BLE UUIDs

### Known Issues:
- ❌ CRC-16 returns 0x0000 (stubbed)
- ❌ AUTN validation not implemented
- ⚠️ Pod IV hardcoded (should be random)
- ⚠️ Security ID not implemented
- ⚠️ IK ignored (may need investigation)

---

*Document generated from reverse engineering analysis of Omnipod5APK and pod simulator codebase.*
