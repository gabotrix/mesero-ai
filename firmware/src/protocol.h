#pragma once
#include <Arduino.h>

// Wire protocol v1 — see docs/protocolo.md.
// This header must stay byte-for-byte compatible with backend/src/protocol.js
// and device-client/device.py.

static const uint8_t PROTO_MAGIC = 0xA5;
static const uint8_t PROTO_VERSION = 0x01;

static const uint8_t FRAME_MIC = 0x01;  // device -> backend
static const uint8_t FRAME_SPK = 0x02;  // backend -> device

static const uint8_t FLAG_VAD = 0b0001;
static const uint8_t FLAG_EOU = 0b0010;
static const uint8_t FLAG_COMFORT = 0b0100;

static const size_t PROTO_HEADER_BYTES = 8;
static const uint16_t DOA_UNKNOWN = 0xFFFF;

// Device-side audio format. Fixed in v1.
static const uint32_t DEVICE_RATE = 16000;
static const uint32_t DEVICE_FRAME_MS = 20;
static const size_t DEVICE_FRAME_SAMPLES = DEVICE_RATE * DEVICE_FRAME_MS / 1000;  // 320
static const size_t DEVICE_FRAME_BYTES = DEVICE_FRAME_SAMPLES * 2;                // 640

/// Writes the 8-byte little-endian header into `out`. Returns bytes written.
inline size_t protoWriteHeader(uint8_t *out, uint8_t type, uint8_t flags,
                               uint16_t seq, uint16_t doa) {
  out[0] = PROTO_MAGIC;
  out[1] = PROTO_VERSION;
  out[2] = type;
  out[3] = flags;
  out[4] = (uint8_t)(seq & 0xFF);
  out[5] = (uint8_t)(seq >> 8);
  out[6] = (uint8_t)(doa & 0xFF);
  out[7] = (uint8_t)(doa >> 8);
  return PROTO_HEADER_BYTES;
}

/// Validates a received frame and reports its type and payload.
inline bool protoParse(const uint8_t *buf, size_t len, uint8_t *type,
                       const uint8_t **payload, size_t *payloadLen) {
  if (len < PROTO_HEADER_BYTES) return false;
  if (buf[0] != PROTO_MAGIC || buf[1] != PROTO_VERSION) return false;
  *type = buf[2];
  *payload = buf + PROTO_HEADER_BYTES;
  *payloadLen = len - PROTO_HEADER_BYTES;
  return true;
}
