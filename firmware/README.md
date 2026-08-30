# Gadget firmware — reSpeaker XVF3800 + XIAO ESP32S3

The XMOS keeps its factory **I2S firmware** and does the hard part in silicon:
acoustic echo cancellation, beamforming, noise suppression, voice activity
detection and direction of arrival. This firmware only moves clean 16 kHz audio
between I2S and a WebSocket, and reports which seat is talking.

## Two ways to use the board, and which one you want

The board has two USB-C ports and two firmware personalities. Confusing them is
the single most common way to lose an afternoon.

| Port | Purpose |
|---|---|
| On the **XIAO module** | Flashing and serial for the ESP32S3 (`VID_303A`, `PID_1001`). Never carries audio. |
| On the **base board**, next to the 3.5 mm jack | XMOS: USB audio *and* DFU firmware updates. |

| Mode | What you get | When to use it |
|---|---|---|
| **I2S** (factory default) | The XIAO reads the array over I2S and streams over WiFi. The board does **not** enumerate on USB at all. | The product. This firmware. |
| **USB** | The array is an ordinary USB microphone and speaker on a PC. The XIAO is out of the audio path. | Fastest way to demo the array with `device-client/`, and useful for isolating audio problems. |

If nothing at all appears when you plug the base-board port in, that is not a
broken cable — it is I2S mode behaving exactly as documented.

## Switching modes (DFU)

Flashing the XMOS needs **safe mode**, because the I2S firmware does not support
USB DFU on its own.

1. Connect the **base board** USB-C port — the one next to the 3.5 mm jack.
2. Hold the **Mute** button, and while holding it, reconnect power.
   The red LED starts blinking: that is safe mode.
3. Flash:

```bash
dfu-util -R -e -a 1 -D respeaker_xvf3800_usb_dfu_firmware_v2.0.x.bin
```

Firmware images live in the
[reSpeaker_XVF3800_USB_4MIC_ARRAY](https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY)
repository:

| File | Mode |
|---|---|
| `respeaker_xvf3800_usb_dfu_firmware_v2.0.x.bin` | USB, 2 channels |
| `respeaker_xvf3800_usb_dfu_firmware_6chl_v2.0.x.bin` | USB, 6 channels |
| `respeaker_xvf3800_i2s_dfu_firmware_v1.0.x.bin` | I2S — flash this to come back |

It is fully reversible. Going to USB mode to demo and back to I2S mode to ship is
a normal thing to do.

Get `dfu-util` with `brew install dfu-util`, `sudo apt install dfu-util`, or the
Windows binaries from the dfu-util site (add the folder to `PATH`, then check
with `dfu-util -V`).

## Pinout

Confirmed against Seeed's own I2S and UDP-streaming examples for this board.

| Signal | GPIO |
|---|---|
| I2S BCLK | 8 |
| I2S WS / LRCLK | 7 |
| I2S data out (→ speaker) | 44 |
| I2S data in (mics →) | 43 |
| XMOS control | I2C, address `0x2C` |

The XMOS delivers **16 kHz, stereo, 32-bit**; the wire protocol is 16-bit mono.
The conversion — left channel, top 16 bits — is in `captureAndSend()`.

### XMOS control registers

| Function | ResID | Cmd | Notes |
|---|---|---|---|
| DOA value | 20 | 18 | 4 bytes: `uint16` azimuth 0–359, `uint16` speech flag |
| LED effect | 20 | 12 | |
| LED brightness | 20 | 13 | |
| LED speed | 20 | 15 | |
| LED colour | 20 | 16 | 3 bytes RGB |

Direction of arrival and voice activity come straight from the array, which is
why the protocol carries `doa` in the audio header instead of guessing on the
microcontroller.

## Build and flash

```bash
cd firmware
pio run                 # compile
pio run -t upload       # flash over the XIAO's USB-C port
pio device monitor      # serial log
```

Without `pio` on your PATH, use `python -m platformio` instead.

## Provisioning

No credentials are compiled in. On first boot the gadget opens a WiFi access
point called **`MeseroAI-setup`**. Join it and a captive portal asks for:

- the WiFi network and password
- the backend host or IP, and port (default `8787`)
- the table id — the `dock`, which must match the NFC tag's `?dock=` value

Settings persist in NVS. To forget them, hold the **BOOT** button on the XIAO
while resetting; the portal reopens.

## What the LED ring is telling you

| Colour | Meaning |
|---|---|
| Barely lit | Idle — nobody has woken the table |
| Amber | Listening |
| Violet | Thinking |
| Warm orange | The agent is talking |

## Behaviour worth knowing

**The microphone never mutes.** The gadget streams even while the agent speaks,
because the XVF3800 removes the speaker's echo in hardware. That is what makes
interrupting it feel natural.

**Barge-in is obeyed instantly.** On `audio_reset` the firmware clears both its
ring buffer and the I2S DMA buffers. Draining a queued sentence after the diner
starts talking is what makes a voice assistant feel deaf.

**Playback is capped at 400 ms.** If the network stalls and recovers, the gadget
drops the backlog rather than replaying a sentence that is no longer relevant.
