# Table dock — 3D printable enclosure

A cylinder the size of the board, with a small cradle standing on the lid. The
array lies flat on top facing the room, the 5 W driver fires down through the
floor beneath it, and the phone leans back against the cradle. That is the whole
object — no rear lobe, no slots, no pockets.

## Dimensions, and where they come from

These are read from the Seeed datasheets, not estimated:

| Value | Source |
|---|---|
| Board ⌀ 102 × 10 mm | `114993700` — listed as 102 × 102 × 10, and the board is round, so that is a boxed circle |
| Microphone circle 66 mm | `114993700` comparison table, XVF3800 column |
| Speaker 50 × 45 × 22 mm | `114993346` — rectangular with mounting ears |

Still unverified, and the reason the coupon exists:

| Parameter | What to measure |
|---|---|
| `mount_hole_dia` | The screw holes on the board |
| `mount_circle_dia` | Diameter of the circle those holes sit on |
| `mount_first_angle` | Where the first hole sits, measured from the front |

## Resulting dock

```
diameter    107.5 mm — a circle, nothing more
body        44.8 mm tall
overall     74.8 mm with the backrest
cradle      66 mm wide, 30 mm backrest, 15 mm gap, leaning 14 deg
```

## Print the coupon first

```bash
openscad -D 'part="calib"' -o calib.stl mesero-dock.scad
```

Ten minutes of filament against four hours for the base. Drop the board in: if
the screws miss, fix `mount_circle_dia` and `mount_first_angle` before printing
anything else.

## Parts

```bash
openscad -D 'part="base"' -o base.stl mesero-dock.scad
openscad -D 'part="lid"'  -o lid.stl  mesero-dock.scad
```

| Part | Notes |
|---|---|
| `base` | Speaker bay, floor vents, cable route, feet |
| `lid` | Microphone ports on the 66 mm circle, LED slot, connector cutouts, phone cradle, NFC pocket |
| `calib` | Fit gauge |

## Print settings

| Setting | Value | Why |
|---|---|---|
| Material | PETG | A table gets wiped with hot cloths and sits in sunlight; PLA sags |
| Nozzle | 0.4 mm | The microphone ports are 1.8 mm |
| Layer | 0.2 mm | |
| Infill | 20 % gyroid | Damps the panel resonance a 5 W driver excites |
| Supports | None | The groove leans 18 deg off vertical; ports print vertically |

## Bill of materials

| Item | Qty |
|---|---|
| M3 × 12 self-tapping screws | 4 |
| 12 mm silicone feet | 3 |
| NTAG213 sticker, 25 mm round | 1 |
| Speaker 114993346 | 1 |

## Three things the renders caught

Each of these was found by looking at an orthographic view, not by reading the
code. Render before printing.

**The board is 102 mm, not 65.** The first version was built around a guess.
Reading the datasheet replaced six estimates with three measured values.

**Ports drilled straight through the cradle.** The microphone holes were cut
after the cradle was unioned onto the plate, so every hole under the backrest
went through it. They are now cut to the plate thickness only, and skipped
entirely in the sector the cradle occupies — a hole into solid plastic is not a
port, it is a weakened joint.

**Strength had to come from the attachment, not the shape.** A flat 3 mm plate
standing 30 mm tall, printed with its layers lying in the bending plane, snaps at
the root the first time somebody leans a phone on it — and the gussets propping
it up poked outside the case.

Curving the wall to follow the rim fixed the strength and broke the function: a
phone is flat, so it touched a concave wall only at its two edges and rocked
between them. The contact face is flat again, and the wall now spans a chord and
is intersected with the body, so both ends merge into the case rim. That makes it
a beam held at both ends rather than a plate cantilevered off the lid, which is
the thing that fails. Its section runs 6.2 mm at the root to 3.2 mm at the lip.

**The lean was mirrored.** The first version reclined the phone forward, over the
microphone array. Sign error in the rotation, caught in an orthographic side
view — never in isometric.

**A phone stand on top shadows the rear microphone.** This is unavoidable, not a
bug: something has to hold the phone, and it has to stand somewhere. The cradle
sits at the rim to shadow as little of the band as possible, and the diner is in
front of the dock, where the array is unobstructed.

## Still to verify on the bench

- The three mounting parameters above
- Whether the connector cutout angles in `lid()` match how the board is rotated
  when it is fitted — those are placed, not measured

## The maker's mark

The GABOTRIX wordmark is sunk 0.8 mm into the front wall of the base, to be
filled by hand after printing — paint, a drop of resin, or a scrap of filament
pressed in warm.

It is **wrapped** around the cylinder, not projected flat onto it, and that is
not a stylistic choice. A 40 mm chord on this 53.75 mm radius falls 3.9 mm away
from the surface at its ends, while the wall is only 2.4 mm thick: a
flat-bottomed pocket would cut clean through the case before it reached the
middle of the word. So the outline is sliced into 60 thin vertical strips and
each is cut radially at its own angle, which keeps the depth the same everywhere.

The outline lives in `gabotrix-logo.svg`, traced from the PNG. To use a different
mark, replace that file and adjust `logo_aspect` to its width ÷ height. To move
or resize it:

| Parameter | What it does |
|---|---|
| `logo_w` | Arc length along the wall, in mm. |
| `logo_z` | Height of its centre above the table. |
| `logo_depth` | Recess depth. Keep it well under `wall` (2.4 mm). |
| `logo_angle` | Where it sits. 90° faces the diner; the cable exit is at 270°. |
| `logo_slices` | Strips used to bend it. 60 keeps the error under a micron. |

Set `logo_w = 0` to leave the wall plain — but note the recess is what makes the
case feel finished, and it costs nothing to print.
