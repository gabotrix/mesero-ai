# Schematics

Two drawings. Between them they account for every connection in the build.

| File | What it shows |
|---|---|
| `mesero-ai-conexiones` | The whole system: the dock, the diner's phone, your server, and which of them are wired to which. The short answer is that the phone is wired to nothing. |
| `mesero-ai-pines` | The six signals that cross between the XIAO and the XVF3800, with the pin each one lands on. |

Each exists as `.svg` (source), `.png` (2× for the web) and `.pdf` (for print).

## There is no circuit to draw

This is worth saying plainly, because a project with a microphone array and an
amplifier sounds like it should have one. It does not. The XIAO seats directly
onto the reSpeaker's 14-pin header, the speaker plugs into a connector that is
already fitted, and the NFC tag is a passive sticker with no electrical
connection to anything. Nothing is soldered during the build and there is no
breadboard stage.

What *is* worth drawing is the signal map, because those pin numbers are the
part you cannot guess, and the isolation between the phone and the gadget,
because it is the design decision the whole project rests on.

## Where the numbers come from

Every pin in `mesero-ai-pines` is read out of the firmware in this repository,
not from a datasheet:

| Signal | GPIO | XIAO pin | Read from |
|---|---|---|---|
| I²S BCLK | 8 | D9 | `firmware/src/main.cpp` — `PIN_I2S_BCLK` |
| I²S WS | 7 | D8 | `firmware/src/main.cpp` — `PIN_I2S_WS` |
| I²S DOUT | 44 | D7 | `firmware/src/main.cpp` — `PIN_I2S_DOUT` |
| I²S DIN | 43 | D6 | `firmware/src/main.cpp` — `PIN_I2S_DIN` |
| I²C SDA | 5 | D4 | `Wire.begin()` with no arguments — the XIAO ESP32S3 variant default |
| I²C SCL | 6 | D5 | as above |
| BOOT | 0 | — | `firmware/src/main.cpp` — `PIN_BOOT_BUTTON` |

The XVF3800 answers on I²C address `0x2C` at 100 kHz (`firmware/src/xvf3800.h`).

## Regenerating them

```bash
pip install svglib reportlab rlPyCairo
python esquemas.py
```

The drawings are generated rather than drawn by hand so that a pin which moves
in the firmware can be corrected in one place. Arrowheads are emitted as
polygons instead of SVG markers on purpose: the renderer that produces the PNG
and the PDF ignores markers, which would quietly strip every direction out of a
signal diagram and leave it looking finished.
