# -*- coding: utf-8 -*-
"""Generates the two schematics, and renders them to PNG and PDF.

    python esquemas.py

Written as code rather than drawn by hand for two reasons. The pin numbers are
read straight out of the firmware, so a pin that moves in the source can be
corrected here in one place. And arrowheads are emitted as polygons instead of
SVG markers: the renderer that produces the PNG and the PDF ignores markers,
which silently strips the direction out of a signal diagram.
"""
import math
import os

OUT = os.path.dirname(os.path.abspath(__file__))

INK = "#1A1411"
BODY = "#4A423C"
DIM = "#5C534C"
FAINT = "#7A6E66"
RULE = "#D8CEC5"
RED = "#C9331F"
WASH = "#FBF9F7"
REDWASH = "#FFF4F2"
FONT = "Helvetica, Arial, sans-serif"


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def txt(x, y, s, size=14, fill=BODY, weight=None, anchor=None, spacing=None):
    a = ['x="%g" y="%g" font-size="%g" fill="%s"' % (x, y, size, fill)]
    if weight:
        a.append('font-weight="%s"' % weight)
    if anchor:
        a.append('text-anchor="%s"' % anchor)
    if spacing:
        a.append('letter-spacing="%g"' % spacing)
    return "  <text %s>%s</text>" % (" ".join(a), esc(s))


def box(x, y, w, h, fill="#FFFFFF", stroke=INK, width=2, r=10, dash=None):
    d = ' stroke-dasharray="%s"' % dash if dash else ""
    return ('  <rect x="%g" y="%g" width="%g" height="%g" rx="%g" fill="%s" '
            'stroke="%s" stroke-width="%g"%s/>' % (x, y, w, h, r, fill, stroke, width, d))


def head(x1, y1, x2, y2, colour, size=9):
    """An arrowhead as a polygon — markers do not survive the PNG/PDF render."""
    ang = math.atan2(y2 - y1, x2 - x1)
    pts = []
    for a, r in ((0, 0), (math.pi - 0.42, size * 1.25), (math.pi + 0.42, size * 1.25)):
        pts.append("%g,%g" % (x2 + r * math.cos(ang + a), y2 + r * math.sin(ang + a)))
    return '  <polygon points="%s" fill="%s"/>' % (" ".join(pts), colour)


def arrow(x1, y1, x2, y2, colour=INK, width=2.5, dash=None, both=False):
    d = ' stroke-dasharray="%s"' % dash if dash else ""
    out = ['  <line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="%g"%s/>'
           % (x1, y1, x2, y2, colour, width, d), head(x1, y1, x2, y2, colour)]
    if both:
        out.append(head(x2, y2, x1, y1, colour))
    return "\n".join(out)


def curve(path, colour=INK, width=2, dash=None):
    d = ' stroke-dasharray="%s"' % dash if dash else ""
    return '  <path d="%s" fill="none" stroke="%s" stroke-width="%g"%s/>' % (
        path, colour, width, d)


def masthead(title, sub, right1, right2, w=1600):
    return "\n".join([
        '  <rect width="%g" height="100%%" fill="#FFFFFF"/>' % w,
        txt(60, 62, title, 34, INK, "700"),
        txt(60, 90, sub, 16.5, DIM),
        txt(w - 60, 62, right1, 15, INK, "700", "end"),
        txt(w - 60, 86, right2, 13, FAINT, anchor="end"),
        '  <line x1="60" y1="112" x2="%g" y2="112" stroke="%s" stroke-width="2"/>' % (w - 60, RULE),
    ])


def footer(y, lines, w=1600):
    out = ['  <line x1="60" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="2"/>'
           % (y, w - 60, y, RULE)]
    for i, l in enumerate(lines):
        out.append(txt(60, y + 32 + i * 26, l, 14, DIM))
    out.append(txt(60, y + 32 + len(lines) * 26 + 6,
                   "Apache-2.0 · github.com/gabotrix/mesero-ai · Seeed Interactive Signage Contest 2026",
                   13, FAINT))
    return "\n".join(out)


def document(w, h, title, desc, body):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %g %g" width="%g" '
            'height="%g" font-family="%s">\n  <title>%s</title>\n  <desc>%s</desc>\n%s\n</svg>\n'
            % (w, h, w, h, FONT, esc(title), esc(desc), body))


# ── diagram 1 · how the three pieces connect ─────────────────────────
def conexiones():
    W, H = 1600, 1000
    p = [masthead("Mesero AI — connection diagram",
                  "Every connection in the build. The gadget hears; the phone only shows.",
                  "GABOTRIX AI®", "reSpeaker XVF3800 + XIAO ESP32S3")]

    # ── the dock
    p += [box(60, 150, 600, 650, WASH, INK, 2.5, 14),
          txt(86, 184, "ON THE TABLE — THE GADGET", 13, RED, "700", spacing=1.5)]

    p += [box(90, 196, 540, 126),
          txt(112, 227, "reSpeaker XVF3800", 19, INK, "700"),
          txt(112, 250, "Seeed 114993700 · XMOS DSP · firmware 1.0.5", 13.5, DIM),
          txt(112, 271, "4 microphones on a 66 mm circle", 13.5, DIM),
          txt(112, 292, "Echo cancellation, beamforming, VAD, direction of arrival", 13.5, DIM),
          txt(112, 313, "Class-D amplifier on board", 13.5, DIM)]
    for cx, cy in ((566, 233), (596, 256), (566, 279), (536, 256)):
        p.append('  <circle cx="%g" cy="%g" r="6.5" fill="%s"/>' % (cx, cy, RED))

    # the two buses, drawn as real arrows so direction survives
    p += [arrow(200, 318, 200, 392, INK, 2.5, both=True),
          box(150, 332, 104, 46, "#FFFFFF", INK, 1.5, 6),
          txt(202, 351, "I²S audio", 13, INK, "700", "middle"),
          txt(202, 369, "16 kHz · 32 bit", 11, DIM, anchor="middle"),
          arrow(470, 318, 470, 392, INK, 2.5, both=True),
          box(420, 332, 104, 46, "#FFFFFF", INK, 1.5, 6),
          txt(472, 351, "I²C control", 13, INK, "700", "middle"),
          txt(472, 369, "0x2C · 100 kHz", 11, DIM, anchor="middle")]

    p += [box(90, 392, 540, 104),
          txt(112, 422, "XIAO ESP32S3", 19, INK, "700"),
          txt(112, 445, "Seats on the array's 14-pin header — no loose wires", 13.5, DIM),
          txt(112, 466, "Streams 20 ms PCM frames; holds Wi-Fi and the venue key", 13.5, DIM),
          txt(112, 487, "BOOT on GPIO0: 3 s clears Wi-Fi · 10 s clears everything", 13.5, DIM)]

    p += [arrow(360, 496, 360, 556, RED, 2.5),
          txt(374, 530, "amplified out", 13, RED),
          box(150, 556, 400, 82),
          txt(172, 585, "Speaker · 8 Ω, 5 W", 18, INK, "700"),
          txt(172, 607, "Seeed 114993346 · 50 × 45 × 22 mm", 13.5, DIM),
          txt(172, 628, "Fires down through the floor of the base", 13.5, DIM)]

    p += [arrow(200, 700, 200, 502, INK, 2.5),
          box(90, 700, 230, 52),
          txt(112, 722, "USB-C — 5 V", 15, INK, "700"),
          txt(112, 741, "power · flashing · provisioning", 12, DIM),
          box(360, 700, 270, 52, "#FFFFFF", INK, 2, 8, dash="6 4"),
          txt(382, 722, "NTAG213 sticker", 15, INK, "700"),
          txt(382, 741, "passive — no power, no wires", 12, DIM)]

    # ── the phone, kept clear of the audio link above it
    p += [box(720, 470, 290, 330, WASH, INK, 2.5, 14),
          txt(746, 504, "THE DINER'S PHONE", 13, RED, "700", spacing=1.5),
          box(800, 524, 130, 190, "#FFFFFF", INK, 2, 16),
          box(813, 544, 104, 150, "#F2EEEA", RULE, 1, 4),
          txt(865, 592, "Menu", 13, INK, "700", "middle"),
          txt(865, 616, "Order", 13, DIM, anchor="middle"),
          txt(865, 640, "Bill", 13, DIM, anchor="middle"),
          txt(865, 742, "Display only — never a microphone", 13, INK, "700", "middle"),
          txt(865, 764, "A web page, not an app", 12.5, DIM, anchor="middle"),
          txt(865, 786, "Opened by the tag: ?dock=mesa-01", 12.5, DIM, anchor="middle")]

    # tap: a short hop from the sticker to the phone, no label to collide
    p += [curve("M 630 726 C 672 726, 686 640, 716 620", INK, 2, "7 5"),
          head(686, 640, 716, 620, INK),
          txt(636, 660, "tap", 13, INK, "700")]

    # ── the server
    p += [box(1070, 150, 470, 400, WASH, INK, 2.5, 14),
          txt(1096, 184, "YOUR SERVER", 13, RED, "700", spacing=1.5),
          box(1096, 202, 418, 148),
          txt(1118, 233, "Node backend", 19, INK, "700"),
          txt(1118, 256, "Railway, a VPS, or a Seeed reComputer", 13.5, DIM),
          txt(1118, 277, "Speech in · order state · speech out", 13.5, DIM),
          txt(1118, 298, "Seat attribution from the array's bearing", 13.5, DIM),
          txt(1118, 319, "Holds the venue key — the only credential", 13.5, DIM),
          txt(1118, 340, "railway.json health-checks /api/health", 13.5, DIM),
          box(1096, 368, 418, 152),
          txt(1118, 399, "Console — seeed.gabotrix.com", 17, INK, "700"),
          txt(1118, 423, "Menu, tables, brand, agent language", 13.5, DIM),
          txt(1118, 444, "Kitchen screen — no second system to log into", 13.5, DIM),
          txt(1118, 465, "Flashes the gadget and puts it on the Wi-Fi,", 13.5, DIM),
          txt(1118, 486, "over USB from the browser (Web Serial)", 13.5, DIM),
          txt(1118, 507, "Stores configuration, never a diner's order", 13.5, DIM)]

    # ── the two links to the backend, routed clear of every box
    p += [curve("M 660 440 C 830 440, 900 276, 1064 276", RED, 3),
          head(900, 276, 1064, 276, RED),
          head(830, 440, 660, 440, RED),
          box(742, 356, 250, 26, REDWASH, "none", 0, 5),
          txt(867, 375, "WebSocket · binary PCM16", 13, RED, "700", "middle"),
          curve("M 1010 600 C 1044 600, 1050 540, 1064 500", INK, 2.5),
          head(1050, 540, 1064, 500, INK),
          head(1044, 600, 1010, 600, INK),
          # Labelled where the link lands: the gutter between the phone and the
          # server is 60 px wide, and anything written in it runs under the note.
          txt(1096, 541, "↕ the phone's own WebSocket — JSON screen state, no audio",
              12.5, DIM)]

    # ── the claim the whole design rests on
    p += [box(1070, 592, 470, 208, REDWASH, RED, 2, 12),
          txt(1096, 626, "No link between them, by design", 16, RED, "700"),
          txt(1096, 656, "The phone and the gadget never talk to each other.", 13.5, BODY),
          txt(1096, 679, "No Bluetooth, no pairing, no local socket.", 13.5, BODY),
          txt(1096, 708, "Each opens its own connection to the backend and", 13.5, BODY),
          txt(1096, 731, "they are matched by the table id in the NFC tag.", 13.5, BODY),
          txt(1096, 760, "That is why the phone never needs the microphone,", 13.5, BODY),
          txt(1096, 783, "and why a locked screen does not stop the order.", 13.5, BODY)]

    p.append(footer(848, [
        "The only soldered joint in the build is the speaker's, and it arrives already made. Everything else plugs together.",
        "Audio path: 4 microphones → XVF3800 (echo cancellation, beamforming) → I²S → ESP32-S3 → Wi-Fi → backend →"
        " back down the same socket → amplifier → speaker.",
    ]))
    return document(W, H, "Mesero AI — system connection diagram",
                    "How the dock, the diner's phone and the backend connect. "
                    "The phone and the dock never talk to each other.", "\n".join(p))


# ── diagram 2 · the six signals between the boards ───────────────────
SIGNALS = [
    ("D9 · GPIO8", "I²S BCLK — bit clock", "clock in", 1, False),
    ("D8 · GPIO7", "I²S WS — word select", "frame in", 1, False),
    ("D7 · GPIO44", "I²S DOUT — the agent's voice, out to the speaker", "to the amplifier", 1, True),
    ("D6 · GPIO43", "I²S DIN — the room, already cleaned up", "from the microphones", -1, True),
    ("D4 · GPIO5", "I²C SDA — data", "address 0x2C", 0, False),
    ("D5 · GPIO6", "I²C SCL — clock, 100 kHz", "bearing, LED ring", 1, False),
]


def pines():
    W, H = 1600, 900
    p = [masthead("Mesero AI — board-to-board signals",
                  "Six signals cross between the two boards. Every number here is read from the firmware.",
                  "GABOTRIX AI®", "No wiring — a 14-pin board-to-board seat")]

    p += [box(120, 176, 330, 496, WASH, INK, 2.5, 12),
          txt(285, 212, "XIAO ESP32S3", 21, INK, "700", "middle"),
          txt(285, 236, "I²S master · Wi-Fi · USB-C", 13, DIM, anchor="middle"),
          box(1150, 176, 330, 496, WASH, INK, 2.5, 12),
          txt(1315, 212, "reSpeaker XVF3800", 21, INK, "700", "middle"),
          txt(1315, 236, "XMOS DSP · I²S slave · amplifier", 13, DIM, anchor="middle")]

    y = 296
    for pin, label, note, direction, hot in SIGNALS:
        colour = RED if hot else INK
        width = 3 if hot else 2.5
        p.append(txt(430, y + 5, pin, 15, colour, "700", "end"))
        if direction >= 0:
            p.append(arrow(450, y, 1150, y, colour, width, both=(direction == 0)))
        else:
            p.append(arrow(1150, y, 450, y, colour, width))
        w = 8.2 * len(label) + 28
        p += [box(800 - w / 2, y - 14, w, 28, "#FFFFFF", "none", 0, 5),
              txt(800, y + 5, label, 15, colour, "700", "middle"),
              txt(1170, y + 5, note, 14, DIM)]
        y += 62

    p += [box(120, 700, 620, 150, WASH, INK, 2, 12),
          txt(146, 732, "The audio format, both directions", 16, INK, "700"),
          txt(146, 762, "16 000 Hz · 32-bit slots · stereo frame · I²S standard", 14.5, BODY),
          txt(146, 786, "One DMA block = 20 ms = 320 samples = 640 bytes of PCM16", 14.5, BODY),
          txt(146, 810, "The ESP32 is the master; the XVF3800 follows its clock", 14.5, BODY),
          txt(146, 834, "MCLK is not connected — the DSP makes its own", 14.5, BODY)]

    p += [box(770, 700, 710, 150, REDWASH, RED, 2, 12),
          txt(796, 732, "What I²C is for — and the trap inside it", 16, RED, "700"),
          txt(796, 762, "The control channel reads which direction a phrase came from. That is what", 14.5, BODY),
          txt(796, 786, "puts each dish on the right diner's tab, and what drives the LED ring.", 14.5, BODY),
          txt(796, 812, "It answers only on XVF3800 firmware 1.0.5. On 1.0.4 the register returns 65535", 14.5, BODY),
          txt(796, 836, "for ever: the gadget still takes orders, but cannot tell two diners apart.", 14.5, BODY)]

    p.append(txt(60, 878,
                 "Apache-2.0 · github.com/gabotrix/mesero-ai · Seeed Interactive Signage Contest 2026",
                 13, FAINT))
    return document(W, H, "Mesero AI — board-to-board signals",
                    "Pin map for the I2S audio bus and the I2C control channel, read from the firmware.",
                    "\n".join(p))


def render(name, svg):
    path = os.path.join(OUT, name + ".svg")
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)
    try:
        from reportlab.graphics import renderPDF, renderPM
        from svglib.svglib import svg2rlg
    except ImportError:
        print("%-26s svg escrito (instala svglib y reportlab para PNG/PDF)" % name)
        return
    d = svg2rlg(path)
    renderPDF.drawToFile(d, os.path.join(OUT, name + ".pdf"))
    d.scale(2, 2)
    d.width, d.height = d.width * 2, d.height * 2
    renderPM.drawToFile(d, os.path.join(OUT, name + ".png"), fmt="PNG", bg=0xFFFFFF)
    print("%-26s svg %3d kB · pdf %3d kB · png %4d kB" % (
        name,
        os.path.getsize(path) // 1024,
        os.path.getsize(os.path.join(OUT, name + ".pdf")) // 1024,
        os.path.getsize(os.path.join(OUT, name + ".png")) // 1024))


if __name__ == "__main__":
    render("mesero-ai-conexiones", conexiones())
    render("mesero-ai-pines", pines())
