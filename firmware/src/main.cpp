/**
 * Mesero AI — gadget firmware for reSpeaker XVF3800 + XIAO ESP32S3.
 *
 * The XMOS keeps its factory I2S firmware and does the hard part in hardware:
 * acoustic echo cancellation, beamforming, noise suppression, and direction of
 * arrival. This firmware carries: it moves already-clean 16 kHz audio between
 * I2S and a WebSocket, and reports where the voice came from.
 *
 * It decides nothing on purpose. It does not know the menu, when a turn ended,
 * or which vendor answers. That logic lives in the backend for four reasons:
 * changing the menu must not mean unscrewing a table; restarting a server takes
 * a second where flashing, rebooting and re-provisioning take minutes; less code
 * on the device is fewer failures somewhere with no serial monitor attached; and
 * the XMOS already does the heavy processing in silicon, so repeating it here
 * would be slower and worse. The edge carries, the centre decides.
 *
 * First boot opens a WiFi portal named "MeseroAI-setup" where the network, the
 * backend address and the table id are entered. Hold the BOOT button during
 * reset to forget them.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <driver/i2s.h>

#include "protocol.h"
#include "xvf3800.h"
#include "portal_ui.h"

// ---------------------------------------------------------------- pinout
// Confirmed against the Seeed wiki for this board (I2S and UDP streaming
// examples both use these).
static const int PIN_I2S_BCLK = 8;
static const int PIN_I2S_WS = 7;
static const int PIN_I2S_DOUT = 44;  // ESP32 -> XVF3800 -> speaker
static const int PIN_I2S_DIN = 43;   // microphones -> ESP32
static const int PIN_BOOT_BUTTON = 0;

static const i2s_port_t I2S_PORT = I2S_NUM_0;

// The XVF3800 speaks 32-bit stereo at 16 kHz; the protocol wants 16-bit mono.
static const size_t I2S_FRAME_BYTES = DEVICE_FRAME_SAMPLES * 2 * 4;  // 2560

// Which I2S channel carries the beamformed, echo-cancelled speech. Override with
// -DMIC_CHANNEL=1 if the level log shows the voice on the right channel instead.
#ifndef MIC_CHANNEL
#define MIC_CHANNEL 0
#endif

// LED animation mode. 0 is a steady colour; 1 blinks. Override to explore other
// effects the XMOS firmware exposes.
#ifndef LED_EFFECT_SOLID
#define LED_EFFECT_SOLID 0
#endif

// The XMOS effect ids are undocumented. These two were identified on the bench
// by cycling every id and watching the ring:
//
//   4  blue ring with a single lit segment tracking the talker. Selecting it
//      also arms the azimuth register — on firmware before 1.0.8 DOA_VALUE
//      stays at zero until this effect has been chosen at least once.
//   1  every LED pulsing together in the chosen colour.
//
// Effect 0 is not "solid", it is off, which is why an earlier build left the
// ring dark.
#ifndef LED_EFFECT_DOA
#define LED_EFFECT_DOA 4
#endif
#ifndef LED_EFFECT_PULSE
#define LED_EFFECT_PULSE 1
#endif

// Playback jitter buffer. 500 ms is well past the 400 ms the protocol allows us
// to hold, so the drain logic below trims rather than the allocation.
static const size_t PLAYBACK_CAPACITY = 48000;  // 1.5 s of 16 kHz PCM16
static const size_t PLAYBACK_MAX_HOLD = DEVICE_FRAME_BYTES * 50;  // 1 s

// ---------------------------------------------------------------- globals

Preferences prefs;

/** The portal blocks inside setup(); loop() never touches it. */
WiFiManager wm;

static void startSocket();
WebSocketsClient ws;
Xvf3800 xmos;

static String cfgHost;
static uint16_t cfgPort;
static String cfgDock;
/**
 * Issued by the console at console.gabotrix.com. It is what lets somebody build
 * this gadget without opening an account at a single vendor: paste it once here
 * and the backend knows which restaurant this table belongs to.
 *
 * Empty is fine — the backend then runs on the carta bundled in the repository,
 * which is how a first evening usually goes.
 */
static String cfgVenueKey;

static bool linkReady = false;   // backend sent `welcome`
static uint16_t txSeq = 0;
static uint16_t lastDoa = DOA_UNKNOWN;
static bool lastSpeech = false;
static uint32_t lastDoaPoll = 0;
static uint32_t doaPollInterval = 100;
static uint8_t doaFailures = 0;
static uint32_t lastTelemetry = 0;
static uint32_t pbUnderruns = 0;   // ran dry mid-sentence
static uint32_t pbDrops = 0;       // arrived faster than we could play

static uint8_t playback[PLAYBACK_CAPACITY];
static volatile size_t pbHead = 0;  // write
static volatile size_t pbTail = 0;  // read

static int32_t i2sIn[DEVICE_FRAME_SAMPLES * 2];
static int32_t i2sOut[DEVICE_FRAME_SAMPLES * 2];
static uint8_t txFrame[PROTO_HEADER_BYTES + DEVICE_FRAME_BYTES];

// ------------------------------------------------------------ ring buffer

static inline size_t pbAvailable() {
  size_t h = pbHead, t = pbTail;
  return (h >= t) ? (h - t) : (PLAYBACK_CAPACITY - t + h);
}

static void pbPush(const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    size_t next = (pbHead + 1) % PLAYBACK_CAPACITY;
    if (next == pbTail) {
      // Full: drop the oldest sample rather than fall further behind.
      pbTail = (pbTail + 2) % PLAYBACK_CAPACITY;
    }
    playback[pbHead] = data[i];
    pbHead = next;
  }
  // Never hold more than the protocol's ceiling.
  while (pbAvailable() > PLAYBACK_MAX_HOLD) {
    pbTail = (pbTail + DEVICE_FRAME_BYTES) % PLAYBACK_CAPACITY;
    pbDrops++;
  }
}

static void pbPop(uint8_t *out, size_t len) {
  for (size_t i = 0; i < len; i++) {
    out[i] = playback[pbTail];
    pbTail = (pbTail + 1) % PLAYBACK_CAPACITY;
  }
}

static void pbClear() {
  pbTail = pbHead;
}

// ------------------------------------------------------------------- LEDs

static void setLedState(const char *state) {
  if (!xmos.present()) return;

  // The backend announces a state change twice (agent_state and led). Acting on
  // both doubles the I2C traffic for no benefit.
  static char current[16] = "";
  if (!strncmp(current, state, sizeof(current))) return;
  strncpy(current, state, sizeof(current) - 1);
  current[sizeof(current) - 1] = 0;

  // Two states, two languages. While the diner has the floor the ring points at
  // whoever is speaking; while the agent answers the whole ring pulses in a
  // different colour, which reads as a voice rather than as a direction.
  if (!strcmp(state, "talking")) {
    xmos.setLedEffect(LED_EFFECT_PULSE);
    xmos.setLedColour(255, 70, 0);  // red-orange
    xmos.setLedSpeed(3);
    xmos.setLedBrightness(255);
  } else if (!strcmp(state, "thinking")) {
    xmos.setLedEffect(LED_EFFECT_PULSE);
    xmos.setLedColour(170, 0, 255);  // violet
    xmos.setLedSpeed(1);
    xmos.setLedBrightness(170);
  } else if (!strcmp(state, "listening")) {
    xmos.setLedEffect(LED_EFFECT_DOA);
    xmos.setLedColour(0, 255, 90);  // the tracking segment turns green
    xmos.setLedBrightness(220);
  } else {
    // Idle still tracks voices, just dimly — the table looks alive, and the
    // azimuth register stays armed for the moment somebody speaks.
    xmos.setLedEffect(LED_EFFECT_DOA);
    xmos.setLedColour(0, 200, 120);
    xmos.setLedBrightness(90);
  }
  Serial.printf("[led] %s\n", state);
}

// -------------------------------------------------------------------- I2S

static bool i2sStart() {
  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_TX);
  cfg.sample_rate = DEVICE_RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 8;
  cfg.dma_buf_len = DEVICE_FRAME_SAMPLES;  // one 20 ms block per DMA buffer
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = true;

  if (i2s_driver_install(I2S_PORT, &cfg, 0, nullptr) != ESP_OK) return false;

  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
  pins.bck_io_num = PIN_I2S_BCLK;
  pins.ws_io_num = PIN_I2S_WS;
  pins.data_out_num = PIN_I2S_DOUT;
  pins.data_in_num = PIN_I2S_DIN;

  if (i2s_set_pin(I2S_PORT, &pins) != ESP_OK) return false;
  i2s_zero_dma_buffer(I2S_PORT);
  return true;
}

/// Reads one 20 ms block and ships it as a mic frame.
static bool captureAndSend() {
  // i2s_read returns whatever the DMA has ready, which for a 20 ms frame is
  // usually less than a full frame. Accumulate across calls: discarding partial
  // reads means never sending anything at all.
  static size_t filled = 0;

  size_t got = 0;
  esp_err_t err = i2s_read(I2S_PORT, ((uint8_t *)i2sIn) + filled, I2S_FRAME_BYTES - filled,
                           &got, pdMS_TO_TICKS(6));
  if (err != ESP_OK) return false;
  filled += got;
  if (filled < I2S_FRAME_BYTES) return false;
  filled = 0;

  // Convert to 16-bit mono. The XMOS sends 32-bit words with the audio in the
  // upper bits, so the top half is the sample we want.
  int16_t *pcm = (int16_t *)(txFrame + PROTO_HEADER_BYTES);
  int32_t peakL = 0, peakR = 0;
  for (size_t i = 0; i < DEVICE_FRAME_SAMPLES; i++) {
    int16_t l = (int16_t)(i2sIn[i * 2] >> 16);
    int16_t r = (int16_t)(i2sIn[i * 2 + 1] >> 16);
    if (abs(l) > peakL) peakL = abs(l);
    if (abs(r) > peakR) peakR = abs(r);
    pcm[i] = MIC_CHANNEL == 0 ? l : r;
  }

  // Periodic level report. If both peaks stay at zero the I2S wiring or format
  // is wrong; if only one moves, that is the channel carrying processed speech.
  static uint32_t lastLevelLog = 0;
  static int32_t holdL = 0, holdR = 0;
  if (peakL > holdL) holdL = peakL;
  if (peakR > holdR) holdR = peakR;
  uint32_t now = millis();
  if (now - lastLevelLog > 2000) {
    lastLevelLog = now;
    Serial.printf("[mic] peak=%ld tx=%u | doa=%u vad=%d | pb=%uB under=%u drop=%u\n",
                  (long)holdL, txSeq, lastDoa, (int)lastSpeech, (unsigned)pbAvailable(),
                  (unsigned)pbUnderruns, (unsigned)pbDrops);
    holdL = holdR = 0;
  }

  if (!linkReady || !ws.isConnected()) return true;

  uint8_t flags = lastSpeech ? FLAG_VAD : 0;
  txSeq++;
  protoWriteHeader(txFrame, FRAME_MIC, flags, txSeq, lastDoa);
  ws.sendBIN(txFrame, sizeof(txFrame));
  return true;
}

/**
 * Writes exactly one 20 ms block of agent speech.
 *
 * Called once per captured frame, which is what keeps playback smooth: input and
 * output share the same I2S clock, so consuming one frame for every frame
 * produced holds the two in lockstep. Draining the whole buffer in a burst — the
 * previous behaviour — starved the microphone read and the socket, and came out
 * of the speaker chopped.
 */
static void drainPlayback() {
  // Hold ~60 ms before starting so a late packet does not cause an underrun on
  // the very first word. Once running, keep going until the buffer truly empties.
  static bool playing = false;
  size_t avail = pbAvailable();
  if (!playing) {
    // Eight frames, not three. Sixty milliseconds of cushion was not enough to
    // ride out WiFi jitter: the buffer ran dry mid-sentence and the agent
    // audibly paused. This costs 100 ms of latency once, at the start of a turn.
    if (avail < DEVICE_FRAME_BYTES * 8) return;
    playing = true;
  }
  if (avail < DEVICE_FRAME_BYTES) {
    // Ran dry while a sentence was still playing: that is an audible gap.
    playing = false;
    pbUnderruns++;
    return;
  }

  uint8_t mono[DEVICE_FRAME_BYTES];
  pbPop(mono, DEVICE_FRAME_BYTES);

  int16_t *s = (int16_t *)mono;
  for (size_t i = 0; i < DEVICE_FRAME_SAMPLES; i++) {
    int32_t v = ((int32_t)s[i]) << 16;
    i2sOut[i * 2] = v;      // left
    i2sOut[i * 2 + 1] = v;  // right
  }

  size_t written = 0;
  i2s_write(I2S_PORT, i2sOut, I2S_FRAME_BYTES, &written, pdMS_TO_TICKS(10));
}

// -------------------------------------------------------------- WebSocket

static void sendHello() {
  StaticJsonDocument<384> doc;
  doc["t"] = "hello";
  doc["proto"] = 1;
  doc["dock"] = cfgDock;
  // Which restaurant this table belongs to. The backend's own VENUE_KEY wins
  // when it has one; this is here so a gadget can be traced to a venue from the
  // server log, and so a future direct-to-cloud mode has what it needs.
  if (cfgVenueKey.length()) doc["venue"] = cfgVenueKey;
  JsonObject dev = doc.createNestedObject("device");
  dev["id"] = String("xiao-") + String((uint32_t)ESP.getEfuseMac(), HEX);
  dev["model"] = "respeaker-xvf3800";
  dev["fw"] = "0.1.0";
  JsonObject audio = doc.createNestedObject("audio");
  audio["rate"] = DEVICE_RATE;
  audio["bits"] = 16;
  audio["ch"] = 1;
  audio["frameMs"] = DEVICE_FRAME_MS;
  JsonArray caps = doc.createNestedArray("caps");
  caps.add("doa");
  caps.add("vad");
  caps.add("aec");
  caps.add("beamforming");

  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

static void handleText(const uint8_t *payload, size_t length) {
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, payload, length)) return;
  const char *t = doc["t"] | "";

  if (!strcmp(t, "welcome")) {
    linkReady = true;
    Serial.printf("[ws] session %s\n", doc["session"] | "?");
  } else if (!strcmp(t, "agent_state")) {
    setLedState(doc["state"] | "idle");
  } else if (!strcmp(t, "audio_reset")) {
    // Barge-in. Everything already queued is stale the instant the diner speaks.
    pbClear();
    i2s_zero_dma_buffer(I2S_PORT);
  } else if (!strcmp(t, "sleep")) {
    pbClear();
    i2s_zero_dma_buffer(I2S_PORT);
    setLedState("idle");
  } else if (!strcmp(t, "led")) {
    setLedState(doc["mode"] | "idle");
  } else if (!strcmp(t, "ping")) {
    StaticJsonDocument<96> pong;
    pong["t"] = "pong";
    pong["ts"] = doc["ts"];
    String out;
    serializeJson(pong, out);
    ws.sendTXT(out);
  }
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[ws] connected");
      linkReady = false;
      pbClear();
      sendHello();
      break;

    case WStype_DISCONNECTED:
      // Name the target: a silent "disconnected" hides the usual cause, which
      // is the gadget dialling a host that is not there.
      Serial.printf("[ws] disconnected (target ws://%s:%u, own ip %s)\n", cfgHost.c_str(),
                    cfgPort, WiFi.localIP().toString().c_str());
      linkReady = false;
      pbClear();
      setLedState("idle");
      break;

    case WStype_TEXT:
      handleText(payload, length);
      break;

    case WStype_BIN: {
      uint8_t ftype = 0;
      const uint8_t *pcm = nullptr;
      size_t pcmLen = 0;
      if (protoParse(payload, length, &ftype, &pcm, &pcmLen) && ftype == FRAME_SPK) {
        pbPush(pcm, pcmLen);
      }
      break;
    }

    default:
      break;
  }
}

// ------------------------------------------------------------------- DOA

static void pollDoa() {
  uint32_t now = millis();
  if (now - lastDoaPoll < doaPollInterval) return;
  lastDoaPoll = now;

  uint16_t deg = 0;
  bool speech = false;
  if (!xmos.readDoa(&deg, &speech)) {
    // Back off rather than block the audio loop with I2C that keeps failing.
    if (doaFailures < 20 && ++doaFailures >= 10) doaPollInterval = 2000;
    return;
  }
  doaFailures = 0;
  doaPollInterval = 100;

  bool changed = (speech != lastSpeech);
  lastDoa = deg;
  lastSpeech = speech;

  // Telemetry is for the screen, not the audio path — keep it slow.
  if (linkReady && ws.isConnected() && (changed || now - lastTelemetry > 1000)) {
    lastTelemetry = now;
    StaticJsonDocument<128> doc;
    doc["t"] = "telemetry";
    doc["vad"] = speech;
    doc["doa"] = deg;
    String out;
    serializeJson(doc, out);
    ws.sendTXT(out);
  }
}

// ----------------------------------------------------------------- setup

// No address is baked in. A default that happens to be one developer's laptop
// is how a device ends up dialling a machine that does not exist on the venue's
// network. Set it in the portal, or pin it per deployment with
// -DDEFAULT_BACKEND_HOST=\"10.0.0.5\" in platformio.ini.
// The hosted backend. A diner is on their own mobile data, not the restaurant's
// WiFi, so the table screen has to be reachable from the internet — which means
// there is no useful local address to default to. Override for a local server.
#ifndef DEFAULT_BACKEND_HOST
#define DEFAULT_BACKEND_HOST "restaurant.gabotrix.com"
#endif
// Lets a bench provision a gadget without opening the portal — useful when the
// same key goes into twenty tables in a row. Never committed with a value in it:
// it is passed on the build command line.
#ifndef DEFAULT_VENUE_KEY
#define DEFAULT_VENUE_KEY ""
#endif

#ifndef DEFAULT_BACKEND_PORT
#define DEFAULT_BACKEND_PORT 443
#endif
#ifndef DEFAULT_DOCK
#define DEFAULT_DOCK "mesa-01"
#endif

static void loadConfig() {
  // Opening read-write creates the namespace, which keeps the first boot from
  // logging an NVS "NOT_FOUND" error.
  prefs.begin("mesero", false);
  cfgHost = prefs.getString("host", DEFAULT_BACKEND_HOST);
  cfgPort = prefs.getUShort("port", DEFAULT_BACKEND_PORT);
  cfgDock = prefs.getString("dock", DEFAULT_DOCK);
  cfgVenueKey = prefs.getString("venue", "");
  prefs.end();
}

static void saveConfig(const String &host, uint16_t port, const String &dock,
                       const String &venueKey) {
  prefs.begin("mesero", false);
  prefs.putString("host", host);
  prefs.putUShort("port", port);
  prefs.putString("dock", dock);
  prefs.putString("venue", venueKey);
  prefs.end();
}

// ------------------------------------------------------- provisioning by wire
//
// The browser can configure this gadget over the same USB cable it was flashed
// with, so nobody has to join a captive portal and type a forty-character venue
// key on a phone keyboard. Chrome's Web Serial opens the port, sends one JSON
// line, and we store it and reboot.
//
// The captive portal stays. Web Serial exists only in desktop Chrome and Edge —
// no Safari, no Firefox, no mobile browser at all — so a restaurant with only a
// phone still needs the portal. This is a second door, not a replacement.
//
// Replies are prefixed because this port is also the log stream, and the
// browser has to pick its answers out of a running commentary about I2S frames.
static const char *WIRE_TAG = "#MESERO ";
/** Defined below, next to the code that opens the socket. */
static bool wsStarted;
static String wireLine;

static void wireReply(const JsonDocument &doc) {
  Serial.print(WIRE_TAG);
  serializeJson(doc, Serial);
  Serial.println();
}

static void wireError(const char *why) {
  StaticJsonDocument<128> out;
  out["ok"] = false;
  out["error"] = why;
  wireReply(out);
}

static void handleWireCommand(const String &line) {
  StaticJsonDocument<512> in;
  if (deserializeJson(in, line)) return;  // Not for us: almost certainly log noise.
  const char *cmd = in["cmd"] | "";

  if (!strcmp(cmd, "hello")) {
    StaticJsonDocument<320> out;
    out["ok"] = true;
    out["device"] = "mesero-ai";
    out["mac"] = WiFi.macAddress();
    out["dock"] = cfgDock;
    out["host"] = cfgHost;
    out["port"] = cfgPort;
    // Never the key itself, only whether there is one. A cable is not a reason
    // to hand a credential back out.
    out["hasVenueKey"] = cfgVenueKey.length() > 0;
    // The first 17 characters — the same slice the platform stores as a key's
    // prefix, so the console can say "that is not one of this restaurant's
    // keys" instead of leaving somebody to discover it from a silent refusal.
    // Enough to identify a key, not enough to use one.
    out["keyHint"] = cfgVenueKey.length() ? cfgVenueKey.substring(0, 17) : "";
    // Enough to tell "cannot reach the network" from "the server refused me",
    // which look identical from the console and have opposite fixes.
    out["wifi"] = WiFi.status() == WL_CONNECTED ? WiFi.SSID() : "";
    out["ip"] = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "";
    out["rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
    out["socket"] = wsStarted;
    wireReply(out);
    return;
  }

  if (!strcmp(cmd, "scan")) {
    /*
     * Station mode has to be on to see anything.
     *
     * The captive portal leaves the radio in AP, and scanNetworks() in AP-only
     * returns zero — so the browser got an empty list at exactly the moment
     * somebody was standing there trying to pick a network. AP_STA keeps the
     * portal alive for whoever might be using it while the scan runs.
     */
    const wifi_mode_t before = WiFi.getMode();
    if (before == WIFI_AP) WiFi.mode(WIFI_AP_STA);
    else if (before == WIFI_OFF) WiFi.mode(WIFI_STA);
    delay(100);

    // Synchronous on purpose: this only ever runs while a person is watching a
    // browser, never while a table is being served.
    int n = WiFi.scanNetworks();
    StaticJsonDocument<1024> out;
    out["ok"] = true;
    JsonArray nets = out.createNestedArray("networks");
    for (int i = 0; i < n && i < 20; i++) {
      JsonObject net = nets.createNestedObject();
      net["ssid"] = WiFi.SSID(i);
      net["rssi"] = WiFi.RSSI(i);
      net["open"] = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
    }
    wireReply(out);
    WiFi.scanDelete();
    /*
     * Put the radio back exactly as it was.
     *
     * Leaving AP_STA on was not a tidiness problem: an access point running
     * alongside the station starves the 20 ms audio loop and, with it, the I2C
     * reads that carry voice activity and direction. The agent came out chopped
     * and could not be interrupted, because the flag that says somebody is
     * talking over it never arrived.
     */
    if (WiFi.getMode() != before) WiFi.mode(before);
    return;
  }

  if (!strcmp(cmd, "config")) {
    const char *ssid = in["ssid"] | "";
    if (!*ssid) { wireError("ssid requerido"); return; }

    /*
     * An empty field means "leave this alone", which is not what ArduinoJson's
     * `|` does: it substitutes the default only when the key is *missing*, so a
     * present-but-empty venue would have wiped the key. That is exactly the
     * wrong outcome for the most common errand this command serves — somebody
     * came to change the WiFi password, not to un-register the gadget.
     */
    auto keep = [&](const char *field, const String &current) {
      const char *v = in[field] | "";
      return *v ? String(v) : current;
    };
    String host = keep("host", cfgHost);
    String dock = keep("dock", cfgDock);
    String venue = keep("venue", cfgVenueKey);
    uint16_t port = in["port"] | cfgPort;
    saveConfig(host, port, dock, venue);

    // WiFi credentials go where the portal would have put them, so both doors
    // lead to the same place and either can be used to correct the other.
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, in["pass"] | "");

    StaticJsonDocument<192> out;
    out["ok"] = true;
    out["saved"] = true;
    out["dock"] = dock;
    wireReply(out);

    // Report the outcome rather than declaring success: a wrong password is the
    // most common thing to happen here, and the browser should be able to say so
    // while the person is still standing at the table with the cable in hand.
    unsigned long until = millis() + 15000;
    while (millis() < until && WiFi.status() != WL_CONNECTED) delay(200);

    StaticJsonDocument<192> res;
    res["ok"] = WiFi.status() == WL_CONNECTED;
    res["event"] = "wifi";
    if (WiFi.status() == WL_CONNECTED) {
      res["ip"] = WiFi.localIP().toString();
    } else {
      res["error"] = "no se pudo conectar a esa red";
    }
    wireReply(res);

    if (WiFi.status() == WL_CONNECTED) {
      delay(300);
      ESP.restart();
    }
    return;
  }
}

/** Non-blocking: reads whatever bytes arrived and acts only on a full line. */
static void pollWire() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (wireLine.length()) handleWireCommand(wireLine);
      wireLine = "";
      continue;
    }
    // A runaway sender must not be able to grow this without bound.
    if (wireLine.length() < 480) wireLine += c;
  }
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println("\nMesero AI gadget");

  pinMode(PIN_BOOT_BUTTON, INPUT_PULLUP);

  if (xmos.begin()) {
    Serial.println("[xmos] control channel up");
    uint8_t vmaj = 0, vmin = 0, vpat = 0;
    if (xmos.readVersion(&vmaj, &vmin, &vpat)) {
      Serial.printf("[xmos] firmware %u.%u.%u - read path OK\n", vmaj, vmin, vpat);
    } else {
      Serial.println("[xmos] version read FAILED — I2C reads are not working at all");
    }
    // Effect 1 is an animation that overrides the colour and blinks forever.
    // Solid is what a status light needs.
    // Select the DOA effect once so the azimuth register starts updating.
    xmos.setLedEffect(LED_EFFECT_DOA);
    xmos.setLedSpeed(1);
    xmos.setLedBrightness(255);
    // Boot self-test: red, green, blue. If the ring stays dark through this,
    // the problem is the LED command, not the agent.
    xmos.setLedColour(255, 0, 0); delay(350);
    xmos.setLedColour(0, 255, 0); delay(350);
    xmos.setLedColour(0, 0, 255); delay(350);
    setLedState("idle");
  } else {
    Serial.println("[xmos] no I2C response — LEDs and DOA disabled");
  }

  if (!i2sStart()) {
    Serial.println("[i2s] init failed");
  }

  // Bench recovery: flashing once with -DFORCE_CFG rewrites the backend address
  // from the compiled defaults without touching saved WiFi credentials. Useful
  // when a device is stuck dialling an address that no longer exists.
#ifdef FORCE_CFG
  // The venue key survives unless the build supplies one: it says which
  // restaurant this table belongs to, not which network it is on, and re-typing
  // a 56-character key on a bench is a punishment nobody deserves.
  saveConfig(DEFAULT_BACKEND_HOST, DEFAULT_BACKEND_PORT, DEFAULT_DOCK,
             strlen(DEFAULT_VENUE_KEY) ? String(DEFAULT_VENUE_KEY) : cfgVenueKey);
  Serial.printf("[cfg] forced to %s:%u dock=%s\n", DEFAULT_BACKEND_HOST,
                (unsigned)DEFAULT_BACKEND_PORT, DEFAULT_DOCK);
#endif

  loadConfig();

  // Brand the portal before anything is added to it. This is the first screen a
  // replicator ever sees of the project, and WiFiManager's default looks like a
  // router admin page.
  wm.setCustomHeadElement(PORTAL_HEAD);
  wm.setTitle("Mesero AI");
  // Ordered by what the person setting up the table actually knows. The venue
  // key and the table number come from the console; the server address is a
  // detail only somebody hosting their own backend has to care about, so it goes
  // last, behind a heading that says as much.
  WiFiManagerParameter pVenue("venue", "Llave del restaurante", cfgVenueKey.c_str(), 72);
  WiFiManagerParameter pDock("dock", "Mesa", cfgDock.c_str(), 32);
  // The server address is folded away. It ships pointing at the hosted backend,
  // and the person setting up a table has no reason to know an address exists —
  // asking them for one only invites a wrong answer. It stays reachable for
  // anybody running their own, one tap down.
  WiFiManagerParameter pAdvOpen(
      "<details class='gbx-adv'><summary>Opciones avanzadas</summary>"
      "<p class='gbx-adv-note'>El servidor ya viene configurado. Cambialo solo si "
      "corres tu propio backend. No es la direccion de este aparato.</p>");
  WiFiManagerParameter pHost("host", "Servidor", cfgHost.c_str(), 60);
  char portBuf[8];
  snprintf(portBuf, sizeof(portBuf), "%u", cfgPort);
  WiFiManagerParameter pPort("port", "Puerto", portBuf, 6);
  WiFiManagerParameter pAdvClose("</details>");

  wm.addParameter(&pVenue);
  wm.addParameter(&pDock);
  wm.addParameter(&pAdvOpen);
  wm.addParameter(&pHost);
  wm.addParameter(&pPort);
  wm.addParameter(&pAdvClose);


  // Persist the custom fields the moment the portal saves them. Reading them
  // after autoConnect() only works when the portal was actually shown — on a
  // boot that reconnects to a saved network the values would silently fall back
  // to their defaults, which is exactly how this device ended up dialling the
  // wrong host.
  wm.setSaveParamsCallback([&pHost, &pPort, &pDock, &pVenue]() {
    uint16_t port = (uint16_t)atoi(pPort.getValue());
    if (port == 0) port = DEFAULT_BACKEND_PORT;
    saveConfig(pHost.getValue(), port, pDock.getValue(), pVenue.getValue());
    Serial.printf("[cfg] saved %s:%u dock=%s\n", pHost.getValue(), port, pDock.getValue());
  });

  /*
   * The portal blocks again, and that is a retreat I am making on purpose.
   *
   * Driving it from loop() so the USB cable could answer with no network was
   * the right idea and I could not land it safely: the first attempt left an
   * access point running that starved the audio loop, and the second rebooted
   * the board every few seconds by changing WiFi mode underneath a TLS
   * handshake. Two regressions in one evening, on a gadget standing in a
   * restaurant, chasing a convenience.
   *
   * So it goes back to what ran all day without complaint. The cost is real
   * and worth naming: the cable only answers once the gadget is on a network,
   * so a board that cannot join one still needs the captive portal. Landing
   * the non-blocking version needs hardware to test against, not another
   * guess.
   */
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect("MeseroAI-setup")) {
    Serial.println("[wifi] provisioning timed out - rebooting");
    ESP.restart();
  }

  loadConfig();
  if (cfgHost.length() == 0) {
    Serial.println("[cfg] no backend address set - reopening the setup portal");
    setLedState("idle");
    wm.startConfigPortal("MeseroAI-setup");
    loadConfig();
    if (cfgHost.length() == 0) {
      Serial.println("[cfg] still no address - rebooting");
      ESP.restart();
    }
  }

  startSocket();
}

/** Opens the socket. Called once, from setup, with WiFi already up. */
static void startSocket() {
  Serial.printf("[wifi] %s  rssi %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  Serial.printf("[ws] %s://%s:%u/device?dock=%s\n", cfgPort == 443 ? "wss" : "ws",
                cfgHost.c_str(), cfgPort, cfgDock.c_str());

  // The venue key rides on the connection so one hosted backend can serve many
  // restaurants: it is what says which carta and which agent this table gets.
  String path = String("/device?dock=") + cfgDock;
  if (cfgVenueKey.length()) path += String("&venue=") + cfgVenueKey;

  // 443 means the hosted backend, which is HTTPS. Anything else is somebody
  // running their own on the local network, where there is no certificate to
  // verify against and plain WebSocket is what they get.
  if (cfgPort == 443) {
    ws.beginSSL(cfgHost.c_str(), cfgPort, path.c_str());
  } else {
    ws.begin(cfgHost.c_str(), cfgPort, path);
  }
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(15000, 3000, 2);
  wsStarted = true;
}

/**
 * Forgets the network after a deliberate three-second press.
 *
 * Checking the button at startup instead would be a trap: holding BOOT during
 * power-on is exactly how the ESP32-S3 is put into firmware download mode, so a
 * routine reflash would silently wipe the table's provisioning.
 */
/**
 * Two gestures, because they answer two different problems.
 *
 * A restaurant changes its WiFi password. That used to cost them the venue key
 * as well: one hold cleared the network *and* wiped NVS, so the price of a new
 * password was finding a forty-character key again and retyping it at the
 * table. Those are not the same event and should not have the same button.
 *
 *   3 s  — forget the network only. Everything that identifies this gadget
 *          survives, and it comes back up asking for a network.
 *   10 s — forget everything, for a gadget leaving for another restaurant.
 *
 * The LED is what tells them apart while the button is down; nobody counts
 * seconds accurately with a finger on a board.
 */
static void checkProvisioningReset() {
  static uint32_t heldSince = 0;
  static bool announcedWifi = false;
  static bool announcedFull = false;

  if (digitalRead(PIN_BOOT_BUTTON) != LOW) {
    // Released. Act on how long it was actually held.
    if (heldSince && millis() - heldSince > 3000) {
      uint32_t held = millis() - heldSince;
      WiFiManager wm;
      wm.resetSettings();
      if (held > 10000) {
        Serial.println("[wifi] BOOT held 10 s - full reset (network, key, table)");
        prefs.begin("mesero", false);
        prefs.clear();
        prefs.end();
      } else {
        Serial.println("[wifi] BOOT held 3 s - network forgotten, key and table kept");
      }
      delay(300);
      ESP.restart();
    }
    heldSince = 0;
    announcedWifi = announcedFull = false;
    return;
  }

  if (heldSince == 0) {
    heldSince = millis();
    return;
  }
  uint32_t held = millis() - heldSince;
  if (held > 3000 && !announcedWifi) {
    announcedWifi = true;
    Serial.println("[wifi] suelta ahora para olvidar solo la red; sigue para borrar todo");
  }
  if (held > 10000 && !announcedFull) {
    announcedFull = true;
    Serial.println("[wifi] suelta ahora para borrar TODO");
  }
}

void loop() {
  ws.loop();
  // Reading Serial.available() costs nothing; the portal, which used to be
  // here too, cost the audio loop everything.
  pollWire();
  checkProvisioningReset();
  pollDoa();
  // One frame out for every frame in. Input and output share the I2S clock, so
  // this pacing is what keeps the speaker smooth.
  if (captureAndSend()) drainPlayback();
}
