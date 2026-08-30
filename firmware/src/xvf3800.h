#pragma once
#include <Arduino.h>
#include <Wire.h>

/**
 * Control channel to the XMOS XVF3800 over I2C.
 *
 * The XMOS exposes a resource/command register model. A write is
 * [resid, cmd, length, payload...]; a read writes [resid, cmd|0x80, length] and
 * then reads back length+1 bytes, the first of which is a status byte.
 *
 * Command IDs are from the XVF3800 control map documented by Seeed:
 *   DOA_VALUE       resid 20, cmd 18, 4 bytes  -> uint16 azimuth, uint16 speech
 *   LED effect      resid 20, cmd 12
 *   LED brightness  resid 20, cmd 13
 *   LED speed       resid 20, cmd 15
 *   LED colour      resid 20, cmd 16
 */
class Xvf3800 {
 public:
  static const uint8_t I2C_ADDR = 0x2C;
  static const uint8_t RESID_GPO = 20;

  static const uint8_t CMD_LED_EFFECT = 12;
  static const uint8_t CMD_LED_BRIGHTNESS = 13;
  static const uint8_t CMD_LED_SPEED = 15;
  static const uint8_t CMD_LED_COLOUR = 16;
  // Command 19, not 18. A parameter table in the docs lists DOA_VALUE as 18;
  // the working example uses 19, and 18 answers with an error status.
  static const uint8_t CMD_DOA_VALUE = 19;

  static const uint8_t RESID_VERSION = 48;
  static const uint8_t CMD_VERSION = 0;

  bool begin() {
    Wire.begin();
    Wire.setClock(100000);
    Wire.beginTransmission(I2C_ADDR);
    present_ = (Wire.endTransmission() == 0);
    return present_;
  }

  bool present() const { return present_; }

  /**
   * Reads the XMOS firmware version (resid 48, cmd 0, three bytes).
   *
   * Doubles as a probe of the read path itself: if this succeeds but a DOA read
   * does not, the read protocol is fine and the running firmware simply does not
   * implement direction of arrival over I2C.
   */
  bool readVersion(uint8_t *major, uint8_t *minor, uint8_t *patch) {
    uint8_t buf[4] = {0};
    if (!readBytes(RESID_VERSION, CMD_VERSION, buf, 3)) return false;
    if (buf[0] != 0) return false;
    *major = buf[1];
    *minor = buf[2];
    *patch = buf[3];
    return true;
  }

  /**
   * Reads the fused direction of arrival.
   * @param azimuth  degrees, 0..359
   * @param speech   true while the XMOS believes someone is talking
   *
   * This is the whole reason the array is worth its price: the angle and the
   * voice-activity flag come out of dedicated hardware, not out of a heuristic
   * running on the microcontroller.
   */
  bool readDoa(uint16_t *azimuth, bool *speech) {
    uint8_t buf[5] = {0};
    if (!readBytes(RESID_GPO, CMD_DOA_VALUE, buf, 4)) {
      reportDoaFailure("i2c read failed", buf);
      return false;
    }
    // buf[0] is the status byte; payload is two little-endian uint16 values.
    if (buf[0] != 0) {
      reportDoaFailure("nonzero status", buf);
      return false;
    }
    uint16_t deg = (uint16_t)(buf[1] | (buf[2] << 8));
    uint16_t vad = (uint16_t)(buf[3] | (buf[4] << 8));
    if (deg > 359) return false;
    *azimuth = deg;
    *speech = vad != 0;
    return true;
  }

  void setLedEffect(uint8_t effect) { writeByte(RESID_GPO, CMD_LED_EFFECT, effect); }
  void setLedBrightness(uint8_t v) { writeByte(RESID_GPO, CMD_LED_BRIGHTNESS, v); }
  void setLedSpeed(uint8_t v) { writeByte(RESID_GPO, CMD_LED_SPEED, v); }

  /**
   * The colour command takes four bytes — blue, green, red, reserved — not a
   * three-byte RGB triple. Sending three is silently ignored by the XMOS, which
   * is why the ring stays dark.
   */
  void setLedColour(uint8_t r, uint8_t g, uint8_t b) {
    uint8_t payload[4] = {b, g, r, 0x00};
    writeBytes(RESID_GPO, CMD_LED_COLOUR, payload, 4);
  }

 private:
  bool present_ = false;
  uint32_t lastDoaReport_ = 0;
  uint8_t lastTxResult_ = 0;
  int lastRxCount_ = 0;

  /// Reports why a DOA read failed, at most once every five seconds.
  void reportDoaFailure(const char *why, const uint8_t *buf) {
    uint32_t now = millis();
    if (now - lastDoaReport_ < 5000) return;
    lastDoaReport_ = now;
    Serial.printf("[doa] %s (endTransmission=%u requestFrom=%d raw=%02X %02X %02X %02X %02X)\n",
                  why, lastTxResult_, lastRxCount_, buf[0], buf[1], buf[2], buf[3], buf[4]);
  }

  void writeBytes(uint8_t resid, uint8_t cmd, const uint8_t *value, uint8_t n) {
    if (!present_) return;
    Wire.beginTransmission(I2C_ADDR);
    Wire.write(resid);
    Wire.write(cmd);
    Wire.write(n);
    for (uint8_t i = 0; i < n; i++) Wire.write(value[i]);
    Wire.endTransmission();
  }

  void writeByte(uint8_t resid, uint8_t cmd, uint8_t value) {
    writeBytes(resid, cmd, &value, 1);
  }

  /**
   * The XMOS wants the request terminated with a STOP and a moment to prepare
   * the payload before the read. Holding the bus with a repeated start returns
   * nothing, which is why direction of arrival came back as "unknown" forever.
   */
  bool readBytes(uint8_t resid, uint8_t cmd, uint8_t *out, uint8_t n) {
    if (!present_) return false;
    Wire.beginTransmission(I2C_ADDR);
    Wire.write(resid);
    Wire.write(cmd | 0x80);  // read flag
    // The length byte counts the status byte too: payload + 1. Sending the bare
    // payload length makes the XMOS answer with an error status.
    Wire.write((uint8_t)(n + 1));
    lastTxResult_ = Wire.endTransmission(true);
    if (lastTxResult_ != 0) {
      lastRxCount_ = -1;
      return false;
    }

    delayMicroseconds(200);

    uint8_t want = n + 1;  // status byte precedes the payload
    lastRxCount_ = Wire.requestFrom((int)I2C_ADDR, (int)want);
    if (lastRxCount_ != want) {
      while (Wire.available()) Wire.read();
      return false;
    }
    for (uint8_t i = 0; i < want; i++) out[i] = Wire.read();
    return true;
  }
};
