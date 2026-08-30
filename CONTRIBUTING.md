# Contributing

Issues and pull requests are welcome. A few things that will save you time.

## Before you build hardware

Print `hardware/case/calib.stl` first. It is a thin coupon carrying the mount
circle and the connector cutouts, and it takes ten minutes. Two numbers in the
case — `mount_circle_dia` and `mount_first_angle` — are not published in any
Seeed datasheet and were measured, so verify them against your board before
committing four hours to the lid.

## Before you change the protocol

[`docs/protocolo.md`](docs/protocolo.md) is normative. The firmware and the
Python client both implement it, and the backend decodes it — a change is three
changes. Frame headers are fixed at eight bytes; new information goes in the
flags byte or in a JSON control message, not in a longer header.

## Before you change timing

The constants in `backend/src/config.js` were found on a bench with a real
speaker in a real room, not chosen. If you change `bargeInLevel`, `echoGuardMs`
or the VAD settings, say what you measured. "It felt better" is not enough — the
failure mode is an agent that interrupts itself, and it only shows up with a
loud speaker at a real table.

## Style

Match the surrounding code. Comments explain *why*, not *what*: the code already
says what it does. If a line looks strange, the comment should say which bug
made it that way.

Spanish for anything a diner or a restaurant reads. English for code,
identifiers, commit messages and these docs.
