# Build one yourself

From an empty desk to a table that takes an order out loud. About three hours,
most of it printing.

This is written for somebody who has not seen the project before. Every number
in it was measured on a bench, and every failure in the troubleshooting section
is one we actually hit — with what it looked like at the time, which is the part
that is usually missing.

---

## What you are building

A cylinder that sits in the middle of a table and listens. A diner taps an NFC
sticker on its cradle, their phone opens a screen bound to that table, and from
then on they talk. The order appears on the screen as they say it; the kitchen
sees it; the bill is paid from the same page.

The part worth building it for: the microphone array reports the **direction**
each phrase came from, so the agent knows *who at the table is speaking*. The
ajiaco is attributed to the person who ordered it, and nobody types a seat
number.

---

## Bill of materials

| Part | Why this one | Approx. |
| --- | --- | --- |
| [reSpeaker XVF3800 + XIAO ESP32S3](https://wiki.seeedstudio.com/respeaker_xvf3800_xiao_getting_started/) | Four microphones with echo cancellation, beamforming and direction of arrival **in hardware**. This is the whole reason the project works in a noisy room. | ~US$45 |
| 8 Ω speaker, 50 × 45 × 22 mm | Seeed 114993346 fits the printed bay exactly. Any speaker of those dimensions works. | ~US$4 |
| NTAG213 sticker, 25 mm round | Passive. No power, no pairing. Every iPhone since the XS reads it natively. | ~US$0.30 |
| PETG filament, ~90 g | PLA warps near a kitchen. | ~US$2 |
| 4 × M3 × 12 mm screws | Lid to base. | — |
| USB-C cable (data, not charge-only) | For flashing. A charge-only cable is the most common first hour lost. | — |

**Software:** [PlatformIO](https://platformio.org/) (VS Code extension),
[OpenSCAD](https://openscad.org/) if you want to change the case, Node.js 20 or
newer, a slicer.

---

## Step 1 — Print the calibration coupon first

Do not print the lid yet. Print this instead; it takes ten minutes.

```bash
git clone https://github.com/gabotrix/mesero-ai.git && cd mesero-ai
openscad -D 'part="calib"' -o calib.stl hardware/case/mesero-dock.scad
```

The coupon carries the mounting circle and the connector cutouts. Two numbers in
the model — `mount_circle_dia` (90 mm) and `mount_first_angle` (45°) — are **not
published in any Seeed datasheet**. They were measured. Hold the coupon against
your board: the four holes should line up and the USB-C cutout should clear the
connector.

If they do not, edit those two values in `hardware/case/mesero-dock.scad` and
print it again. Ten minutes now against four hours of lid later.

## Step 2 — Print the case

```bash
openscad -D 'part="base"' -o base.stl hardware/case/mesero-dock.scad
openscad -D 'part="lid"'  -o lid.stl  hardware/case/mesero-dock.scad
```

PETG, 0.2 mm layers, 4 walls, 25% infill. No supports — the model is designed
without overhangs that need them. Base takes about 2 h 20, lid about 1 h 40.

**The base has the GABOTRIX wordmark sunk 0.8 mm into its front wall**, to be
filled by hand afterwards with paint or a scrap of filament pressed in warm. To
put your own mark there, replace `hardware/case/gabotrix-logo.svg` and set
`logo_aspect` to its width ÷ height. `logo_w = 0` leaves the wall plain.

The mark is *wrapped* around the cylinder rather than projected flat onto it,
and that is not decoration: a 40 mm chord on this 53.75 mm radius falls 3.9 mm
away from the surface at its ends while the wall is only 2.4 mm thick, so a
flat-bottomed pocket would cut straight through the case before it reached the
middle of the word.

## Step 3 — Assemble

1. Seat the speaker in the rectangular bay in the base. It is a friction fit.
2. Run the speaker wires up through the cable channel.
3. Set the reSpeaker board on the four bosses, microphones facing **up**.
4. Screw the lid down, 4 × M3 × 12.
5. Stick the NTAG213 under the phone cradle, on the flat.

Do not write the tag yet — you need the table's address first, in step 7.

## Step 4 — Flash the firmware

```bash
cd firmware && pio run -t upload
```

If the board is not found: hold **BOOT**, tap **RESET**, release BOOT. That puts
the ESP32-S3 into download mode. On Windows you may need
[Zadig](https://zadig.akeo.ie/) once to bind the WinUSB driver.

Watch it come up:

```bash
pio device monitor
```

You want lines like `[mic] peak=… doa=… vad=…`. If `peak` stays near zero, the
board is in USB mode rather than I2S mode — see troubleshooting.

### Check the XVF3800's own firmware version

The first line matters more than it looks:

```
[xmos] firmware 1.0.5 - read path OK
```

**It has to be 1.0.5 or newer.** On 1.0.4 the direction-of-arrival register does
not answer: `readDoa` gets a fixed error, and `doa` stays at 65535 with `vad` at
0 forever. The gadget still hears, still streams, still takes orders — it simply
cannot tell one diner from another, and the agent cannot be interrupted, because
the flag that says somebody is talking over it never arrives.

Two boards from the same order can differ. We lost an evening to it: one gadget
attributed dishes to five separate customers and its twin, running a
byte-identical build, reported nothing at all. The version line is the only
place that difference is visible before you are standing at a table wondering
why nobody is being recognised.

Seeed's updater flashes the XVF3800 over USB; it is a separate chip from the
XIAO and reflashing the ESP32 never touches it.

## Step 5 — Set up your restaurant

Go to the console, create an account and a restaurant, and build your carta:
categories, dishes, prices, photos. Add one table per gadget you are installing,
and give the agent a name and a character.

Then, under **Conexión**, generate a **venue key**. It looks like this:

```
msr_live_7f3a91c2e4b6d8005a1c9f3e2b7d4a6c8e0f1234abcd
```

Copy it now. It is shown once and only its hash is stored — we cannot read it
back to you, which is the property that makes a stolen database harmless.

> **Prefer not to use our service at all?** Skip this step. The backend runs on
> the carta committed in `backend/menu.json` with no account and no key. What you
> lose is the voice, which is the part we host — see *Making it yours* below for
> running your own model instead.

## Step 6 — Run the backend

Pick one.

**On your laptop, to try it:**

```bash
cd backend && npm install
VENUE_KEY=msr_live_… node src/index.js
```

**As a container, for a real restaurant:**

```bash
docker build -t mesero-ai .
docker run -p 8787:8787 -e VENUE_KEY=msr_live_… mesero-ai
```

**Hosted, which is what a real deployment wants.** A diner uses their own mobile
data — they are not going to join the restaurant's WiFi before dinner — so the
table screen has to be reachable from the internet. `deploy/cloud/` has a
compose file with Caddy in front, which obtains and renews the certificate by
itself. See [`servidor.md`](servidor.md).

You should see:

```
  Mesero AI backend
  pack        mesero
  provider    gabotrix (gemini-live) venue=msr_live_7f3…
  carta       Your Restaurant (plataforma)
  http        http://localhost:8787
```

`carta … (plataforma)` means the key worked and your menu came down. If it says
`local`, the key did not resolve and it fell back to the file — which is
deliberate: a restaurant whose internet drops at seven in the evening still
serves dinner.

## Step 7 — Point the gadget at it

There are two doors. Take the first one if you have a laptop.

### From the browser, over the USB cable

Open the console on **Chrome or Edge on a computer** and use *Conectar gadget*.
It flashes the firmware, asks the gadget which WiFi networks *it* can see from
where it is standing, and writes the network, the table and the venue key down
the same cable. Nothing is typed on a phone.

This is also how somebody with no PlatformIO installed gets a working board:
steps 4 and 7 collapse into one button, and the toolchain never enters the
story.

> Web Serial exists only in desktop Chrome and Edge. Not Safari, not Firefox,
> and no mobile browser at all — which is exactly why the second door stays.

The same screen lives in **Conexión → Conectar un gadget** for a restaurant
that already exists. That is where the commonest errand happens: the WiFi
password changed. Plug the gadget in, pick the new network, save. It keeps its
venue key and its table — you only change what you came to change.

### Forgetting a network without forgetting everything

Holding **BOOT** on the gadget does two different things, and the difference
matters:

| Hold | What it forgets |
| --- | --- |
| 3 seconds | The WiFi network only. Venue key and table survive. |
| 10 seconds | Everything, for a gadget moving to another restaurant. |

Watch the serial monitor while you hold it — it says which one you are about to
get before you let go. This used to be a single gesture that wiped all of it,
so the price of a new WiFi password was finding a forty-character key again.

### From a phone, over the gadget's own WiFi

Power the gadget. It raises a WiFi network called **MeseroAI-setup**. Join it
from a phone and the setup page opens by itself.

The fastest way: in the console, open **Mesas**, press the QR button on the
table you are setting up, and scan it with the phone's camera. The page opens
with the table already filled in. Paste your venue key, choose the restaurant's
WiFi, and save.

> The portal cannot scan the code itself. A captive portal is plain HTTP at
> 192.168.4.1 and browsers refuse camera access outside a secure context — no
> library changes that. The phone's own camera app does the scanning.

Watch the monitor. You want:

```
[ws] connected
[ws] session s_4d448318
[mic] peak=8712 tx=1 | doa=301 vad=1
```

`tx=1` means audio is going out. `doa` is the bearing it is hearing.

## Step 8 — Write the NFC tag

With any NFC writer app, write a **URL record** to the sticker:

```
https://your-backend/?dock=mesa-01
```

The `dock` must match what you set on the gadget. That string is the only thing
pairing the gadget with the diner's phone — both open a socket to the backend
and are matched by it.

Lock the tag afterwards if the app offers it. Table stickers get picked at.

## Step 9 — Talk to it

Sit down. Say **"mesero"**, then order something from your carta.

What should happen: the LED ring points at you, the agent answers out loud, and
the dish appears on the phone screen attributed to *Cliente 1*. Have somebody
sitting elsewhere order something — they become *Cliente 2*, and their dish is
theirs.

Ask for the bill. It should ask which number to send the receipt to, read it
back to confirm, and send the payment link by WhatsApp.

---

## When it does not work

Every one of these happened to us. The symptom is what you will actually see.

### The board does not appear on USB at all

**Not a cable fault** — or not only. The reSpeaker ships in I2S mode, and in
that mode it does not enumerate as a USB device. Confirm the XIAO itself
enumerates; that is the board you flash.

### `[mic] peak=0` forever, nothing transmits

The XMOS chip is in the wrong mode, or the wrong I2S channel is being read.
Override the channel and reflash:

```bash
pio run -t upload --build-flag="-DMIC_CHANNEL=1"
```

We chased this as a wiring fault for an hour. It was a partial `i2s_read`: the
driver returns fewer bytes than asked for and the firmware was discarding the
remainder instead of accumulating across calls.

### The agent speaks in chops

The model emits a whole sentence at once and the device buffer overruns. The
backend meters delivery at real time to prevent exactly this, and holds a
cushion of frames before it starts playing so a slow patch of network does not
run the speaker dry mid-word. That cushion is `PRIME_FRAMES`, default 10. Lower
it and you get underruns; we measured 17 per reply before this existed.

### The agent hears itself and orders its own dinner

Genuinely happened. The turn was being ended at `turn_end`, which means the model
stopped *generating* — but playback trails generation by the whole length of the
queue, so the microphone gate opened while the speaker was still talking. The
turn ends when the queue drains, not when the model stops.

### You cannot interrupt it

Our first attempt gated barge-in on volume. Measured on the bench: the agent's
own voice returns at a peak of 19074 and a person speaking reaches 31545. No
threshold separates those. The XVF3800 runs its voice detector *after* echo
cancellation, so it stays quiet through the agent's own speech — that flag is
the answer, and four consecutive frames of it (80 ms) now cut the agent off.

### Everyone at the table is "Cliente 1"

Bearings were being read when the model called a tool, which is seconds after
the person stopped speaking — by then the register holds something stale. They
are sampled only while the array reports speech now, and cleared every turn.
Leaving them behind was its own bug: the next person's angles piled onto the
previous person's and the average landed at a point where nobody was sitting.

### `doa` is always 0

Firmware 1.0.4 of the XMOS chip has no DOA register. Update the reSpeaker to
1.0.6 or later. Then note that the register only updates once LED effect 4 has
been selected at least once — which is why that effect is the resting state.

### The LED ring stays dark

Effect 0 is *off*, not *solid*. And the colour command takes four bytes in the
order B, G, R, 0 — not three RGB.

### The gadget connects and is immediately dropped

`[ws] connected` followed at once by `[ws] disconnected`. The backend refused
it. Either the venue key on the gadget does not match the one the backend was
started with, or you are running a build from before device authentication —
check the server log for `device refused`.

### The backend dies the moment a gadget connects

`ReferenceError: WebSocket is not defined`. You are on Node 20, where the global
WebSocket does not exist — it became reliable in 22. The code imports the `ws`
client precisely so this does not happen; if you have edited a provider, do the
same.

### A feature silently does nothing

Check the boot log for a config error. Every tuning constant is asserted numeric
at startup because three of them once went missing from the config, and
`n >= undefined` is quietly `false` — the features simply switched themselves
off, with no error anywhere, and it looked like a hardware problem for a day.

---

## How it actually works

**The firmware is deliberately dumb.** It moves already-clean 16 kHz audio
between I2S and a WebSocket and reports the bearing. It does not know the menu,
when a turn ended, or which vendor answers. That is on purpose: changing a menu
must not mean unscrewing a table, restarting a server takes a second where
reflashing takes minutes, and the XMOS chip already does the heavy processing in
silicon.

**The phone never touches the hardware.** iOS Safari has neither Web Bluetooth
nor Web Serial, and it drops microphone permission when the screen locks. So the
two never talk to each other — both open a plain WebSocket to the backend and
are matched by the `dock` id the NFC tag encodes. Nothing on the phone asks for
a permission.

**The wire protocol** is eight bytes of header and then PCM16: magic, version,
type, flags, sequence, bearing. The bearing rides in the audio header because it
changes per frame. It is specified in [`protocolo.md`](protocolo.md), and the
firmware and the Python client implement it identically.

---

## Making it yours

**The carta, the tables, the agent's character and your colours** are all in the
console. The table screen reads your colours at load, so a change reaches every
table on the next tap — nothing rebuilt, nothing reflashed.

**A different domain entirely.** An agent pack owns the prompt, the tools the
model may call, and how a tool call changes the screen. Nothing else in the
stack knows what is being sold. A second pack is one file in
`backend/src/packs/` and one line in the registry.

**Your own voice model.** `PROVIDER=openai` uses your credential;
`PROVIDER=local` talks to a model on your own hardware and keeps working when
the internet does not. The contract for a local one is four messages in and four
out — see [`voz-local.md`](voz-local.md). An adapter in front of whisper.cpp and
a small model is about a hundred lines.

**No microphone array yet?** `device-client/` is a Python stand-in that speaks
the same protocol using your laptop's microphone. You can build and understand
the entire system before the hardware arrives.
