#!/usr/bin/env python3
"""
Desktop stand-in for the reSpeaker gadget.

It speaks exactly the protocol in docs/protocolo.md, so the ESP32S3 firmware and
this script are interchangeable from the backend's point of view. Develop and
demo against this today; swap in the board later without touching the backend.

    python device.py --list-devices
    python device.py --dock mesa-01
    python device.py --dock mesa-01 --input "reSpeaker"
    python device.py --selftest            # local mic -> speaker, no backend

Install:
    pip install -r requirements.txt
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import math
import struct
import sys
import threading
import time

# Windows consoles default to a legacy codepage and blow up on device names that
# contain non-Latin characters. Force UTF-8 before anything prints.
# Line buffering keeps the log readable when the output is piped or captured.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, ValueError):
        pass

try:
    import sounddevice as sd
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency. Run: pip install -r requirements.txt")

try:
    import websockets
except ImportError:  # pragma: no cover
    sys.exit("Missing dependency. Run: pip install -r requirements.txt")


# ----------------------------------------------------------------- protocol

MAGIC = 0xA5
VERSION = 0x01
FRAME_MIC = 0x01
FRAME_SPK = 0x02

FLAG_VAD = 0b0001

HEADER = struct.Struct("<BBBBHH")  # magic, version, type, flags, seq, doa
HEADER_BYTES = HEADER.size  # 8
DOA_UNKNOWN = 0xFFFF

RATE = 16000
FRAME_MS = 20
FRAME_SAMPLES = RATE * FRAME_MS // 1000  # 320
FRAME_BYTES = FRAME_SAMPLES * 2  # 640

# Jitter buffer: start playing after this many frames, never hold more than max.
PREBUFFER_FRAMES = 3  # 60 ms
MAX_BUFFER_FRAMES = 20  # 400 ms


def encode_frame(ftype: int, pcm: bytes, seq: int = 0, flags: int = 0, doa: int = DOA_UNKNOWN) -> bytes:
    return HEADER.pack(MAGIC, VERSION, ftype, flags, seq & 0xFFFF, doa & 0xFFFF) + pcm


def decode_frame(buf: bytes):
    if len(buf) < HEADER_BYTES:
        return None
    magic, version, ftype, flags, seq, doa = HEADER.unpack_from(buf, 0)
    if magic != MAGIC or version != VERSION:
        return None
    return ftype, flags, seq, doa, buf[HEADER_BYTES:]


# -------------------------------------------------------------- audio plumbing


class Playback:
    """Jitter-buffered speaker queue, drained by the sounddevice callback."""

    def __init__(self) -> None:
        self.frames: collections.deque[bytes] = collections.deque()
        self.lock = threading.Lock()
        self.started = False
        self.silence = b"\x00" * FRAME_BYTES

    def push(self, pcm: bytes) -> None:
        with self.lock:
            self.frames.append(pcm)
            # Drop the oldest audio rather than drift further behind the agent.
            while len(self.frames) > MAX_BUFFER_FRAMES:
                self.frames.popleft()
            if not self.started and len(self.frames) >= PREBUFFER_FRAMES:
                self.started = True

    def pull(self) -> bytes:
        with self.lock:
            if not self.started:
                return self.silence
            if not self.frames:
                self.started = False
                return self.silence
            return self.frames.popleft()

    def flush(self) -> None:
        """Barge-in: the agent was interrupted, drop everything not yet heard."""
        with self.lock:
            self.frames.clear()
            self.started = False

    def depth(self) -> int:
        with self.lock:
            return len(self.frames)


def rms(pcm: bytes) -> int:
    n = len(pcm) // 2
    if n == 0:
        return 0
    total = 0
    for sample, in struct.iter_unpack("<h", pcm):
        total += sample * sample
    return int(math.sqrt(total / n))


# ------------------------------------------------------------------- client


class DeviceClient:
    def __init__(self, args) -> None:
        self.args = args
        self.url = (
            f"{args.url}/device?dock={args.dock}"
            + (f"&token={args.token}" if args.token else "")
        )
        self.playback = Playback()
        self.mic_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=100)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.seq = 0
        self.ready = False
        self.agent_state = "idle"

        # Cheap local VAD. The real board gets this from the XVF3800 instead.
        self.noise_floor = 250.0
        self.speaking = False
        self.speech_frames = 0
        self.silence_frames = 0

    # -- audio device callbacks (run on a PortAudio thread) ------------------

    def on_input(self, indata, frames, time_info, status) -> None:
        if status:
            pass  # over/underflow flags are noisy on Windows; ignore
        if self.loop is None:
            return
        data = bytes(indata)
        try:
            self.loop.call_soon_threadsafe(self.mic_q.put_nowait, data)
        except (RuntimeError, asyncio.QueueFull):
            pass

    def on_output(self, outdata, frames, time_info, status) -> None:
        pcm = self.playback.pull()
        need = len(outdata)
        if len(pcm) < need:
            pcm = pcm + b"\x00" * (need - len(pcm))
        outdata[:] = pcm[:need]

    # -- VAD ----------------------------------------------------------------

    def update_vad(self, level: int) -> bool:
        if level < self.noise_floor * 2.5:
            self.noise_floor = self.noise_floor * 0.95 + level * 0.05
            self.noise_floor = max(self.noise_floor, 80.0)
        threshold = max(600.0, self.noise_floor * 3.0)

        if level > threshold:
            self.speech_frames += 1
            self.silence_frames = 0
        else:
            self.silence_frames += 1
            if self.silence_frames >= 8:
                self.speech_frames = 0

        if self.speech_frames >= 3:
            self.speaking = True
        elif self.silence_frames >= 12:
            self.speaking = False
        return self.speaking

    # -- main loop ----------------------------------------------------------

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        backoff = 0.5
        while True:
            try:
                await self.session()
                backoff = 0.5
            except (OSError, websockets.exceptions.WebSocketException) as exc:
                print(f"  link down: {exc}")
            except asyncio.CancelledError:
                raise
            print(f"  reconnecting in {backoff:.1f}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 10.0)

    async def session(self) -> None:
        print(f"  connecting to {self.url}")
        async with websockets.connect(self.url, max_size=None) as ws:
            print("  link up")
            self.ready = False
            self.playback.flush()

            await ws.send(
                _json(
                    {
                        "t": "hello",
                        "proto": 1,
                        "dock": self.args.dock,
                        "device": {
                            "id": f"desktop-{self.args.dock}",
                            "model": "desktop-mock",
                            "fw": "0.1.0",
                        },
                        "audio": {"rate": RATE, "bits": 16, "ch": 1, "frameMs": FRAME_MS},
                        "caps": ["vad"],
                    }
                )
            )

            sender = asyncio.create_task(self.pump_mic(ws))
            telemetry = asyncio.create_task(self.pump_telemetry(ws))
            try:
                await self.pump_incoming(ws)
            finally:
                sender.cancel()
                telemetry.cancel()

    async def pump_incoming(self, ws) -> None:
        async for raw in ws:
            if isinstance(raw, bytes):
                decoded = decode_frame(raw)
                if not decoded:
                    continue
                ftype, _flags, _seq, _doa, pcm = decoded
                if ftype == FRAME_SPK and pcm:
                    self.playback.push(pcm)
                continue

            msg = _loads(raw)
            kind = msg.get("t")

            if kind == "welcome":
                self.ready = True
                print(f"  session {msg.get('session')} — streaming")
            elif kind == "agent_state":
                self.agent_state = msg.get("state", "idle")
                print(f"  agent: {self.agent_state}")
            elif kind == "audio_reset":
                self.playback.flush()
                print("  barge-in: playback flushed")
            elif kind == "wake":
                print(f"  woken ({msg.get('reason')})")
            elif kind == "sleep":
                self.playback.flush()
                print(f"  asleep ({msg.get('reason')})")
            elif kind == "led":
                pass  # the real board drives its WS2812 ring here
            elif kind == "ping":
                await ws.send(_json({"t": "pong", "ts": msg.get("ts")}))

    async def pump_mic(self, ws) -> None:
        while True:
            pcm = await self.mic_q.get()
            if not self.ready:
                continue
            level = rms(pcm)
            speaking = self.update_vad(level)
            self.seq = (self.seq + 1) & 0xFFFF
            flags = FLAG_VAD if speaking else 0
            await ws.send(encode_frame(FRAME_MIC, pcm, seq=self.seq, flags=flags))

    async def pump_telemetry(self, ws) -> None:
        last = None
        while True:
            await asyncio.sleep(0.2)
            if not self.ready:
                continue
            if self.speaking != last:
                last = self.speaking
                await ws.send(
                    _json({"t": "telemetry", "vad": self.speaking, "rms": int(self.noise_floor)})
                )


# ------------------------------------------------------------------ helpers

import json as _jsonmod


def _json(obj) -> str:
    return _jsonmod.dumps(obj)


def _loads(raw):
    try:
        return _jsonmod.loads(raw)
    except Exception:
        return {}


def list_devices() -> None:
    print(sd.query_devices())
    print("\nDefault input / output:", sd.default.device)


def resolve_device(name_or_index, kind: str):
    """Accepts an index, or a case-insensitive substring of the device name."""
    if name_or_index is None:
        return None
    try:
        return int(name_or_index)
    except (TypeError, ValueError):
        pass
    needle = str(name_or_index).lower()
    for idx, dev in enumerate(sd.query_devices()):
        channels = dev["max_input_channels"] if kind == "input" else dev["max_output_channels"]
        if channels > 0 and needle in dev["name"].lower():
            print(f"  {kind}: matched '{dev['name']}' (index {idx})")
            return idx
    sys.exit(f"No {kind} device matching '{name_or_index}'. Try --list-devices.")


def selftest(args) -> None:
    """Mic straight to speaker. Proves the audio path before blaming the network."""
    print("Self-test: speak — you should hear yourself. Ctrl+C to stop.")
    pb = Playback()

    def on_in(indata, frames, t, status):
        pb.push(bytes(indata))

    def on_out(outdata, frames, t, status):
        pcm = pb.pull()
        need = len(outdata)
        outdata[:] = (pcm + b"\x00" * need)[:need]

    with sd.RawInputStream(
        samplerate=RATE, blocksize=FRAME_SAMPLES, dtype="int16", channels=1,
        device=resolve_device(args.input, "input"), callback=on_in,
    ), sd.RawOutputStream(
        samplerate=RATE, blocksize=FRAME_SAMPLES, dtype="int16", channels=1,
        device=resolve_device(args.output, "output"), callback=on_out,
    ):
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            print("\nstopped")


def main() -> None:
    ap = argparse.ArgumentParser(description="Desktop stand-in for the reSpeaker gadget")
    ap.add_argument("--url", default="ws://localhost:8787", help="backend base URL")
    ap.add_argument("--dock", default="mesa-01", help="table id, must match the screen")
    ap.add_argument("--token", default=None)
    ap.add_argument("--input", default=None, help="input device index or name substring")
    ap.add_argument("--output", default=None, help="output device index or name substring")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--selftest", action="store_true", help="local mic->speaker loopback")
    args = ap.parse_args()

    if args.list_devices:
        list_devices()
        return

    if args.selftest:
        selftest(args)
        return

    client = DeviceClient(args)
    in_dev = resolve_device(args.input, "input")
    out_dev = resolve_device(args.output, "output")

    print(f"\n  Mesero AI — device client")
    print(f"  dock   {args.dock}")
    print(f"  audio  {RATE} Hz / PCM16 / mono / {FRAME_MS} ms frames\n")

    with sd.RawInputStream(
        samplerate=RATE, blocksize=FRAME_SAMPLES, dtype="int16", channels=1,
        device=in_dev, callback=client.on_input,
    ), sd.RawOutputStream(
        samplerate=RATE, blocksize=FRAME_SAMPLES, dtype="int16", channels=1,
        device=out_dev, callback=client.on_output,
    ):
        try:
            asyncio.run(client.run())
        except KeyboardInterrupt:
            print("\n  stopped")


if __name__ == "__main__":
    main()
