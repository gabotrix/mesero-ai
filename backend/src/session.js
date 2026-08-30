import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { createProvider, describeProvider } from './providers/index.js';
import { Resampler, FrameSplitter, rms } from './audio.js';
import { SeatMap, angleDistance } from './seats.js';
import { createPaymentLink, checkPayment } from './payments.js';
import { sendPaymentLink, sendReceipt } from './notify.js';
import {
  encodeAudioFrame,
  FLAG_VAD,
  FRAME_SPK,
  DEVICE_RATE,
  DEVICE_FRAME_MS,
  DEVICE_FRAME_SAMPLES,
  DOA_UNKNOWN,
} from './protocol.js';

const SPK_FRAME_BYTES = DEVICE_FRAME_SAMPLES * 2; // 20 ms of PCM16 @ 16 kHz

/**
 * One table. Owns the agent conversation, the order state, the gadget and every
 * screen currently looking at this dock.
 *
 * Why the phone never touches the hardware
 * ----------------------------------------
 * iOS Safari exposes neither Web Bluetooth nor Web Serial, and it drops
 * microphone permission the moment the screen locks. So the phone is not a peer
 * of the gadget at all: both sides open a plain WebSocket to this backend and
 * are matched by their `dock` id, which is exactly what the NFC tag encodes
 * (`/?dock=mesa-01`). Nothing on the phone needs a permission prompt.
 *
 * The agent is not started when the gadget boots — an always-listening table
 * would burn model time talking to nobody. It is started by a *wake*: the diner
 * taps the NFC tag (a screen attaches), an external system posts the wake
 * webhook, or the gadget's own button is pressed.
 */
export class Session {
  /**
   * @param {string} dock
   * @param {any} pack
   */
  constructor(dock, pack) {
    this.id = `s_${randomUUID().slice(0, 8)}`;
    this.dock = dock;
    this.pack = pack;
    this.state = pack.initialState();

    this.agentState = 'idle';
    this.transcript = [];
    this.doa = DOA_UNKNOWN;
    this.lastBearingStrength = 0;
    /** Angles heard at this table, clustered into diners. */
    this.seats = new SeatMap();
    this.lastVad = false;
    this.awake = false;
    this.lastActivity = Date.now();

    /** @type {any} */
    this.device = null;
    this.deviceInfo = null;
    /** @type {Set<any>} */
    this.uis = new Set();

    this.seq = 0;
    // Audio counters. They turn "it does not work" into a number: mic frames
    // prove the array is being heard, speaker frames prove the reply was sent.
    this.micFrames = 0;
    this.spkFrames = 0;
    this.micLevel = 0;
    this.suppressedFrames = 0;
    // Peak levels per state. Setting a barge-in threshold without knowing the
    // echo ceiling is guesswork; these make it measurable.
    this.peakWhileTalking = 0;
    this.peakWhileListening = 0;
    /** Ignore the room for a moment after the agent stops: echo has a tail. */
    this.echoGuardUntil = 0;
    /** Consecutive speech frames heard while the agent holds the floor. */
    this.bargeFrames = 0;
    /**
     * Bearings measured while a customer is actually speaking.
     *
     * Reading the azimuth register when a tool call arrives looked equivalent
     * and was not: the model answers seconds after the person stopped, by which
     * time the register holds a default or a stale value. That produced phantom
     * customers sitting at exactly 0 and exactly 90 degrees, and merged two real
     * people into one.
     */
    this.utteranceSamples = [];
    this.lastBearing = null;
    this.lastVadAt = 0;
    /** Audio arriving before this instant is dropped: the agent chose to stay out. */
    this.silentUntil = 0;
    /** Consecutive speech frames heard while asleep, for waking on a voice. */
    this.wakeVadFrames = 0;
    this.servedTimer = null;
    this.paymentPoll = null;
    /** The model has finished generating; playback may still be draining. */
    this.turnComplete = false;

    /** Frames waiting to be metered out to the gadget at real time. */
    this.spkQueue = [];
    this.pacer = null;
    this.pacerDue = 0;

    this.micToProvider = new Resampler(DEVICE_RATE, config.providerRate);
    this.providerToSpk = new Resampler(config.providerRate, DEVICE_RATE);
    this.spkSplitter = new FrameSplitter(SPK_FRAME_BYTES);

    /** @type {import('./providers/types.js').RealtimeProvider|null} */
    this.provider = null;
    this.graceTimer = null;
  }

  // ------------------------------------------------------------------- wake

  /**
   * Brings the table to life. Idempotent, so every trigger can call it freely.
   * @param {string} reason
   */
  wake(reason) {
    this.lastActivity = Date.now();
    if (this.awake) {
      // Already awake, but the model connection can have dropped while the
      // table had no gadget attached — in which case nothing would ever restart
      // it and the table would sit awake and mute. startProvider() is a no-op
      // when one is already running.
      this.startProvider();
      return false;
    }
    this.awake = true;
    this.log(`wake (${reason})`);
    this.broadcastUi({ t: 'awake', awake: true, reason });
    this.sendToDevice({ t: 'wake', session: this.id, reason });
    this.startProvider();
    return true;
  }

  /** Puts the table back to sleep and releases the model connection. */
  sleep(reason = 'idle') {
    if (!this.awake) return;
    this.awake = false;
    this.log(`sleep (${reason})`);
    this.stopProvider();
    this.sendToDevice({ t: 'sleep', reason });
    this.broadcastUi({ t: 'awake', awake: false, reason });
  }

  // ---------------------------------------------------------------- provider

  startProvider() {
    if (this.provider) return;
    // The agent greets as soon as it connects. Starting it before the gadget is
    // attached throws that greeting away, and the diner is met with silence.
    if (!this.device) return;

    const provider = createProvider({
      sessionOverride: this.pack.buildSession?.() ?? null,
    });
    this.provider = provider;

    provider.on('ready', () => {
      this.log(`agent ready (pack=${this.pack.id} provider=${describeProvider()})`);
      this.setAgentState('listening');
    });

    provider.on('audio', (pcm24) => {
      // The agent decided this turn was not its business. Nothing it says now
      // reaches the table.
      if (Date.now() < this.silentUntil) return;
      // First audio of a turn is the honest signal that the agent is speaking.
      this.turnComplete = false;
      if (this.agentState !== 'talking') this.setAgentState('talking');
      this.sendSpeechToDevice(pcm24);
    });

    provider.on('interrupted', () => {
      this.log('barge-in');
      this.flushPlayback();
      this.setAgentState('listening');
    });

    provider.on('turn_end', () => {
      // The model has stopped generating, but the gadget is still playing what
      // it generated — the backend meters delivery at real time, so playback
      // trails generation by the whole length of the queue. Declaring the turn
      // over here would open the microphone gate while the speaker is still
      // talking, and the agent would hear itself, answer itself, and order its
      // own dinner. Wait for the queue to drain.
      this.turnComplete = true;
      if (!this.spkQueue.length) this.finishSpeaking();
    });

    provider.on('tool', ({ name, args }) => {
      this.lastActivity = Date.now();
      this.log(`tool ${name} ${JSON.stringify(args)}`);
      // Attribute to whoever was speaking, not to whatever the register reads
      // now — the model replies long after the customer stopped talking.
      // Prefer the bearing frozen when the turn ended: that is the person the
      // model is answering. The live buffer may already belong to whoever
      // started talking next.
      // Mid-turn fallback: the model answered before the pause that freezes a
      // bearing, so estimate from what has arrived so far.
      const liveEst = this.utteranceSamples.length >= config.bearingMinSamples
        ? bearingOf(this.utteranceSamples)
        : null;
      const live = liveEst && liveEst.strength >= config.bearingMinStrength ? liveEst.angle : null;
      const seat = this.seats.resolve(
        this.lastBearing ?? live,
        this.lastBearing != null ? this.lastBearingStrength : liveEst?.strength,
      );
      this.log(`bearing live=${live} frozen=${this.lastBearing} samples=${this.utteranceSamples.length} vadFrames=${this.vadFrameCount} seat=${seat?.label ?? 'ninguno'}`);

      // The deployed bridge logs transcripts and throws them away, so the model
      // is asked to report what it heard through the tool channel instead —
      // which does reach us. A workaround, not a design: a bridge that forwarded
      // transcription events would be cheaper and would not depend on the model
      // remembering to call it.
      // Not addressed to us. Cut whatever the model started saying before any of
      // it reaches the table, and record nothing: what customers say to each
      // other is their business, and putting it on a screen would be worse than
      // interrupting them.
      if (name === 'stay_silent') {
        this.log(`staying silent (${args.reason || 'not addressed'})`);
        // Cancelling what is queued is not enough: the model often emits a word
        // or two after the tool call, and a waiter who mutters at a table he was
        // not part of is worse than one who says nothing. Drop the rest of the
        // turn outright.
        this.silentUntil = Date.now() + config.silenceHoldMs;
        this.flushPlayback();
        this.setAgentState('listening');
        return;
      }

      if (name === 'log_utterance') {
        const text = String(args.text || '');
        if (this.pack.isPromptEcho?.(text)) {
          this.log('dropped prompt echo from log_utterance');
          return;
        }
        this.addTranscript('user', text, seat);
        this.broadcastUi({ t: 'tool', name, args, seat });
        return;
      }
      const changed = this.pack.applyTool(this.state, name, args, { seat, doa: this.doa });
      if (name === 'request_bill') {
        // The reducer has already put the number on the table state, so the
        // link and the WhatsApp that follows both know where to go.
        this.requestPayment().then(() => this.pushPaymentLink());
      }
      this.state.seats = this.seats.list();
      this.broadcastUi({ t: 'tool', name, args, seat });
      if (changed) this.broadcastUi({ t: 'state', state: this.state });
    });

    provider.on('transcript', ({ role, text }) => this.addTranscript(role, text));

    provider.on('error', (err) => {
      this.log(`provider error: ${err.message}`);
      this.broadcastUi({ t: 'error', message: err.message });
    });

    provider.on('closed', ({ code, reason }) => {
      this.log(`provider closed ${code} ${reason}`);
      this.provider = null;
      this.setAgentState('idle');
      // Only chase a reconnect while somebody is actually at the table.
      if (this.awake && this.device) setTimeout(() => this.startProvider(), 800);
    });

    provider.connect();
  }

  stopProvider() {
    this.provider?.close();
    this.provider = null;
    this.setAgentState('idle');
  }

  // ------------------------------------------------------------------ device

  attachDevice(ws, hello) {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.device = ws;
    this.deviceInfo = hello?.device || null;
    this.log(`device attached (${this.deviceInfo?.model || 'unknown'})`);

    ws.send(
      JSON.stringify({
        t: 'welcome',
        session: this.id,
        audio: { rate: DEVICE_RATE, bits: 16, ch: 1, frameMs: 20 },
        keepaliveMs: 15000,
      })
    );

    this.broadcastUi({ t: 'device', online: true, info: this.deviceInfo });

    // A screen was already waiting at this table, or the table was woken before
    // the gadget finished booting. Either way this is the moment the agent can
    // actually be heard, so it is the moment to start it.
    if (this.uis.size > 0 || this.awake) this.wake('device_joined_active_table');
  }

  detachDevice() {
    this.device = null;
    this.spkQueue.length = 0;
    this.stopPacer();
    this.log('device detached');
    this.broadcastUi({ t: 'device', online: false });
    this.setAgentState('idle');

    // Hold the order briefly so a WiFi blip stays invisible to the diner.
    this.graceTimer = setTimeout(() => {
      this.stopProvider();
      this.awake = false;
      this.log('grace window expired');
    }, config.sessionGraceSeconds * 1000);
  }

  /** Mic audio arriving from the gadget. */
  handleDeviceAudio(frame) {
    if (frame.doa !== DOA_UNKNOWN && frame.doa !== this.doa) {
      this.doa = frame.doa;
      this.broadcastUi({ t: 'doa', doa: frame.doa });
    }
    this.micFrames++;

    // Asleep, but somebody at the table started speaking. There is no local
    // speech recognition yet, so the gadget cannot listen for the word "mesero"
    // specifically — what it can tell is that a person is talking, which is
    // enough to bring the agent back. If it turns out they were talking to each
    // other, stay_silent handles it and the table settles down again.
    if (!this.awake) {
      if (frame.flags & FLAG_VAD) {
        this.wakeVadFrames++;
        if (this.wakeVadFrames >= config.wakeVadFrames) {
          this.wakeVadFrames = 0;
          this.wake('voice');
        }
      } else {
        this.wakeVadFrames = 0;
      }
      return;
    }
    // Which half of the sampling condition is failing? Counting them apart is
    // the difference between fixing it and guessing at it.
    if (frame.flags & FLAG_VAD) this.framesVad = (this.framesVad || 0) + 1;
    if (frame.doa !== DOA_UNKNOWN) this.framesDoa = (this.framesDoa || 0) + 1;
    if ((frame.flags & FLAG_VAD) && frame.doa !== DOA_UNKNOWN) {
      this.framesBoth = (this.framesBoth || 0) + 1;
    }
    if (!this.provider?.ready) return;

    const level = rms(frame.pcm);
    this.micLevel = level;
    if (this.agentState === 'talking') {
      if (level > this.peakWhileTalking) this.peakWhileTalking = level;
    } else if (level > this.peakWhileListening) {
      this.peakWhileListening = level;
    }

    // While the agent has the floor, forward audio only when the array says it
    // is speech.
    //
    // A level gate alone cannot do this. Measured on the bench with the real
    // speaker: the agent's own voice comes back at a peak of 19074 and a diner
    // speaking reaches 31545 — far too close to separate with a threshold, and
    // the agent kept stopping mid-sentence because its own echo cleared the bar.
    //
    // The XVF3800 runs its voice-activity detector after echo cancellation, so
    // it stays quiet through the agent's own speech and fires for a real voice.
    // That flag rides in every frame header; it is a far better answer than any
    // number we could pick here.
    const speech = Boolean(frame.flags & FLAG_VAD);
    const guarded = this.agentState === 'talking' || Date.now() < this.echoGuardUntil;
    if (guarded && (!speech || level < config.bargeInLevel)) {
      this.suppressedFrames++;
      this.bargeFrames = 0;
      return;
    }

    // Cut the agent off ourselves rather than hoping the model notices.
    //
    // A few consecutive frames the array called speech, while the agent holds
    // the floor, is somebody talking over it — the detector runs after echo
    // cancellation, so the agent's own voice does not set it. One frame is a
    // cough or a plate; `bargeInFrames` of them in a row is a person, and by
    // then only a fraction of a second has passed.
    if (this.agentState === 'talking' && speech) {
      this.bargeFrames = (this.bargeFrames || 0) + 1;
      if (this.bargeFrames >= config.bargeInFrames) {
        this.bargeFrames = 0;
        this.log('barge-in (array vad)');
        this.flushPlayback();
        this.provider?.cancelResponse?.();
        this.setAgentState('listening');
      }
    } else if (!speech) {
      this.bargeFrames = 0;
    }

    // Sample the bearing only while the array reports speech. Everything else is
    // the register idling, and idling reads as a customer who is not there.
    if (frame.flags & FLAG_VAD && frame.doa !== DOA_UNKNOWN) {
      this.vadFrameCount = (this.vadFrameCount || 0) + 1;
      this.utteranceSamples.push(frame.doa);
      // Short window on purpose. A long one spans a change of speaker, and the
      // circular mean of two people sitting apart is a point where nobody is.
      if (this.utteranceSamples.length > config.bearingWindow) this.utteranceSamples.shift();
      this.lastVadAt = Date.now();
    } else if (this.utteranceSamples.length && Date.now() - this.lastVadAt > 700) {
      // The turn ended. Freeze who was speaking, then clear — always, even when
      // there were too few samples to trust. Leaving them behind was the bug:
      // the next person's bearings piled onto the previous person's and the
      // average landed between the two, so the table looked like one customer.
      const est = this.utteranceSamples.length >= config.bearingMinSamples
        ? bearingOf(this.utteranceSamples)
        : null;
      if (est && est.strength >= config.bearingMinStrength) {
        this.lastBearing = est.angle;
        this.lastBearingStrength = est.strength;
      } else {
        // Too few samples, or samples that disagreed. Say so rather than
        // reusing the previous speaker's bearing: this turn was somebody, and
        // pinning it on whoever spoke last is the one outcome nobody forgives.
        this.lastBearing = null;
        this.lastBearingStrength = 0;
        if (est) this.log(`bearing descartado R=${est.strength.toFixed(2)} n=${this.utteranceSamples.length}`);
      }
      this.utteranceSamples = [];
    }

    this.lastActivity = Date.now();
    const pcm24 = this.micToProvider.process(frame.pcm);
    if (pcm24.length) this.provider.sendAudio(pcm24);
  }

  handleDeviceTelemetry(msg) {
    const vad = Boolean(msg.vad);
    if (vad !== this.lastVad) {
      this.lastVad = vad;
      this.broadcastUi({ t: 'vad', vad });
    }
    // Voice activity deliberately does not drive the agent state. Inferring
    // "thinking" from the microphone going quiet was a guess, and a wrong one:
    // a diner pausing to read the menu looked identical to the model working,
    // so the table sat in "thinking" and the ring stopped showing direction.
    // Only the model itself says when it is speaking.
    if (typeof msg.doa === 'number' && msg.doa !== this.doa) {
      this.doa = msg.doa;
      this.broadcastUi({ t: 'doa', doa: msg.doa });
    }
  }

  handleDeviceButton(msg) {
    if (msg.id === 'call_waiter') {
      this.wake('device_button');
      this.state.waiterCalled = true;
      this.broadcastUi({ t: 'state', state: this.state });
    } else if (msg.id === 'wake') {
      this.wake('device_button');
    }
  }

  /**
   * Queues agent speech for delivery at real time.
   *
   * The model emits a whole sentence far faster than it is spoken. Forwarding
   * that burst straight to the gadget overruns its buffer, and a microcontroller
   * with 320 KB of RAM cannot hold eight seconds of audio — so it drops frames
   * and the sentence comes out full of holes. The backend has the memory, so the
   * backend does the metering: the gadget receives 20 ms every 20 ms.
   */
  sendSpeechToDevice(pcm24) {
    const pcm16k = this.providerToSpk.process(pcm24);
    if (!pcm16k.length) return;
    for (const pcm of this.spkSplitter.push(pcm16k)) this.spkQueue.push(pcm);
    this.startPacer();
  }

  startPacer() {
    if (this.pacer) return;
    // Prime the gadget's jitter buffer, then hold real time.
    this.pacerDue = Date.now();
    // Hand over a deeper head start than the gadget's own prebuffer.
    // Priming four frames left it running dry mid-sentence — the device logged
    // seventeen underruns in half a minute, which is what the pauses were.
    let primed = 0;
    while (primed < config.primeFrames && this.spkQueue.length) {
      this.emitSpeechFrame();
      primed++;
    }
    this.pacer = setInterval(() => this.tickPacer(), 10);
  }

  stopPacer() {
    if (this.pacer) {
      clearInterval(this.pacer);
      this.pacer = null;
    }
  }

  tickPacer() {
    if (!this.spkQueue.length) {
      this.stopPacer();
      if (this.turnComplete) this.finishSpeaking();
      return;
    }
    const now = Date.now();
    // Time-based accounting rather than one frame per tick, so timer jitter does
    // not accumulate into drift over a long answer.
    if (this.pacerDue < now - 500) this.pacerDue = now; // recover from a stall
    let sent = 0;
    while (this.spkQueue.length && this.pacerDue <= now && sent < 12) {
      this.emitSpeechFrame();
      this.pacerDue += DEVICE_FRAME_MS;
      sent++;
    }
  }

  /**
   * Called when the last queued frame has been handed to the gadget.
   *
   * The guard covers what is still in flight after that: the device's own jitter
   * buffer and its I2S DMA, plus the tail of the sound in the room.
   */
  finishSpeaking() {
    if (this.agentState !== 'talking') return;
    this.turnComplete = false;
    this.echoGuardUntil = Date.now() + config.echoGuardMs;
    this.setAgentState('listening');
  }

  emitSpeechFrame() {
    const pcm = this.spkQueue.shift();
    if (!pcm) return;
    const ws = this.device;
    if (!ws || ws.readyState !== 1) return;
    this.seq = (this.seq + 1) & 0xffff;
    this.spkFrames++;
    ws.send(encodeAudioFrame({ type: FRAME_SPK, seq: this.seq, doa: DOA_UNKNOWN, pcm }));
  }

  /** Barge-in: drop everything queued, here and on the gadget. */
  flushPlayback() {
    // The queued sentence is stale the instant the diner interrupts.
    this.spkQueue.length = 0;
    this.turnComplete = false;
    this.stopPacer();
    this.spkSplitter.reset();
    this.providerToSpk = new Resampler(config.providerRate, DEVICE_RATE);
    this.sendToDevice({ t: 'audio_reset' });
  }

  sendToDevice(msg) {
    if (this.device?.readyState === 1) this.device.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------------- UI

  attachUi(ws) {
    this.uis.add(ws);
    // Keep the seat list on the state object so a snapshot is self-contained.
    this.state.seats = this.seats.list();
    ws.send(
      JSON.stringify({
        t: 'snapshot',
        session: this.id,
        dock: this.dock,
        pack: this.pack.id,
        menu: this.pack.menu || null,
        agentState: this.agentState,
        deviceOnline: Boolean(this.device),
        awake: this.awake,
        state: this.state,
        transcript: this.transcript.slice(-30),
        doa: this.doa,
      })
    );

    // This is the NFC tap: a diner just sat down and opened the table screen.
    this.wake('screen_attached');
  }

  detachUi(ws) {
    this.uis.delete(ws);
  }

  handleUiAction(msg) {
    this.lastActivity = Date.now();
    if (msg.action === 'call_waiter') {
      this.state.waiterCalled = true;
      this.broadcastUi({ t: 'state', state: this.state });
      this.provider?.sendText('El cliente pidió llamar al mesero desde la pantalla.');
    } else if (msg.action === 'say' && typeof msg.text === 'string') {
      this.provider?.sendText(msg.text);
    } else if (msg.action === 'wake') {
      this.wake('ui_button');
    } else if (msg.action === 'pay') {
      // Kept on the table state, not on the phone: the receipt has to survive
      // the screen locking, and the POS needs to see it too.
      if (typeof msg.phone === 'string' && msg.phone.replace(/\D/g, '').length >= 10) {
        this.state.customerPhone = msg.phone.replace(/\D/g, '');
        // requestPayment() only broadcasts when it actually builds a link, and
        // it returns early once one exists. Without this the screen would never
        // learn that the number it just sent was accepted.
        this.broadcastUi({ t: 'state', state: this.state });
      }
      // The link may already exist — asked for out loud, before anybody typed a
      // number — so the WhatsApp push hangs off the phone arriving, not off the
      // link being built.
      this.requestPayment().then(() => this.pushPaymentLink());
    } else if (msg.action === 'sleep') {
      // Somebody has to be able to switch it off. A table that keeps an agent
      // connected after the diners leave burns model time and keeps a live
      // microphone in an empty room.
      this.sleep('ui_button');
    } else if (msg.action === 'reset') {
      this.resetTable();
    }
  }

  broadcastUi(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.uis) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  /**
   * Kitchen workflow, driven from the POS. The voice agent only ever creates
   * tickets (confirm_order); moving them to preparing/ready/served is a staff
   * decision, so it arrives over HTTP, not through the model.
   */
  setTicketStatus(ticketId, status) {
    if (!this.pack.setTicketStatus?.(this.state, ticketId, status)) return false;
    this.log(`ticket ${ticketId} → ${status}`);
    this.broadcastUi({ t: 'state', state: this.state });
    this.announceTicket(ticketId, status);
    this.checkTableServed();
    return true;
  }

  /**
   * Tells the table what the kitchen just did.
   *
   * Phrased by the model rather than by a canned string, so it comes out in the
   * language that customer was using and names the dishes the way it named them
   * a moment ago.
   */
  announceTicket(ticketId, status) {
    const line = config.ticketAnnouncements[status];
    if (!line || !this.provider?.ready) return;
    const dishes = (this.state.items || [])
      .filter((it) => it.ticket === ticketId)
      .map((it) => `${it.qty || 1} ${it.label}`)
      .join(', ');
    if (!dishes) return;
    // Marked as a system note so it is never mistaken for something a customer
    // said and echoed into the transcript.
    this.silentUntil = 0;
    this.provider.sendText(`[sistema] ${line} ${dishes}. ${config.ticketAnnounceStyle}`);
  }

  /** Order served and nothing left pending: let the table go quiet by itself. */
  checkTableServed() {
    const tickets = this.state.tickets || [];
    const served = tickets.length > 0 && tickets.every((t) => t.status === 'served');
    if (!served) {
      if (this.servedTimer) {
        clearTimeout(this.servedTimer);
        this.servedTimer = null;
    this.paymentPoll = null;
      }
      return;
    }
    if (this.servedTimer) return;
    this.log('table served — sleeping shortly');
    this.servedTimer = setTimeout(() => {
      this.servedTimer = null;
    this.paymentPoll = null;
      this.sleep('served');
    }, config.serveSleepMs);
  }

  /**
   * Turns the running total into something payable.
   *
   * Built here rather than on the phone so the merchant keys stay server-side,
   * and so the same link is handed to every screen watching this table — the
   * diner's phone, the POS, a second phone. One bill, one link, one payment.
   */
  async requestPayment() {
    if (this.state.payment?.status === 'pending' || this.state.payment?.status === 'paid') {
      return this.state.payment;
    }
    const total = this.state.total || 0;
    try {
      const link = await createPaymentLink({
        amount: total,
        reference: `${this.dock}-${Date.now()}`,
        description: `${this.pack.menu?.restaurant || 'Restaurante'} · ${this.dock}`,
      });
      this.state.payment = {
        status: 'pending',
        amount: total,
        url: link.paymentUrl,
        linkId: link.linkId,
        sandbox: link.sandbox,
      };
      this.log(`payment link ${link.linkId} for ${total}${link.sandbox ? ' (sandbox)' : ''}`);
      this.broadcastUi({ t: 'state', state: this.state });
      this.startPaymentPolling();
    } catch (err) {
      this.state.payment = { status: 'error', amount: total, message: err.message };
      this.log(`payment link failed: ${err.message}`);
      this.broadcastUi({ t: 'state', state: this.state });
    }
    return this.state.payment;
  }

  /**
   * Sends the payment link to the number the diner left, once.
   *
   * Guarded by a flag on the payment itself rather than by a local variable:
   * pressing the button twice, or the agent asking for the bill again after a
   * number was already given, must not send the same template twice — every one
   * of them is a billed WhatsApp message.
   */
  async pushPaymentLink() {
    const pay = this.state.payment;
    const phone = this.state.customerPhone;
    if (!phone || !pay || pay.status !== 'pending' || pay.notified) return;
    pay.notified = true;
    try {
      const res = await sendPaymentLink({
        phone,
        paymentUrl: pay.url,
        reference: `${this.dock}-${pay.linkId}`,
        amount: pay.amount,
      });
      if (res.sent) this.log(`whatsapp payment link -> ${phone} (${res.messageId})`);
      else {
        pay.notified = false;
        this.log(`whatsapp payment link skipped: ${res.reason}`);
      }
    } catch (err) {
      pay.notified = false;
      this.log(`whatsapp payment link failed: ${err.message}`);
    }
  }

  /**
   * The receipt, after the money actually moved.
   *
   * Failing here is not allowed to matter: the table has paid and is standing up
   * to leave. Whatever happens gets logged and the meal ends normally.
   */
  async pushReceipt() {
    const pay = this.state.payment;
    const phone = this.state.customerPhone;
    if (!phone || pay?.status !== 'paid') return;
    try {
      const res = await sendReceipt({
        phone,
        transactionId: pay.transactionId || pay.linkId,
        amount: pay.amount,
        items: this.state.items,
      });
      this.log(res.sent ? `whatsapp receipt -> ${phone}` : `whatsapp receipt skipped: ${res.reason}`);
    } catch (err) {
      this.log(`whatsapp receipt failed: ${err.message}`);
    }
  }

  /**
   * Wompi tells nobody when a link is paid; somebody has to ask.
   *
   * Polling is not elegant, but a webhook would need this backend reachable from
   * the internet, and the whole point of it living on the restaurant's own
   * network is that it is not.
   */
  startPaymentPolling() {
    if (this.paymentPoll) return;
    let tries = 0;
    this.paymentPoll = setInterval(async () => {
      const linkId = this.state.payment?.linkId;
      if (!linkId || this.state.payment.status !== 'pending' || ++tries > 120) {
        this.stopPaymentPolling();
        return;
      }
      try {
        const res = await checkPayment(linkId);
        if (res.paid) {
          this.state.payment.status = 'paid';
          this.state.payment.transactionId = res.transactionId;
          this.log(`payment approved ${res.transactionId ?? ''}`);
          this.broadcastUi({ t: 'state', state: this.state });
          this.broadcastUi({ t: 'paid', payment: this.state.payment });
          this.pushReceipt();
          this.provider?.sendText(
            '[sistema] El pago de la mesa fue aprobado. Agradece brevemente y despídete, ' +
              'en el idioma de quien pidió.'
          );
          this.stopPaymentPolling();
        }
      } catch {
        /* transient; the next tick asks again */
      }
    }, 4000);
  }

  stopPaymentPolling() {
    if (this.paymentPoll) {
      clearInterval(this.paymentPoll);
      this.paymentPoll = null;
    }
  }

  /** Clears the table from the POS: order served, diners gone. */
  resetTable() {
    this.state = this.pack.initialState();
    this.seats.reset();
    this.transcript = [];
    this.broadcastUi({ t: 'state', state: this.state });
    this.broadcastUi({ t: 'reset' });
  }

  /** Pushes a menu edit to every screen watching this table. */
  broadcastMenu() {
    this.broadcastUi({ t: 'menu', menu: this.pack.menu || null });
  }

  /**
   * Applies a pack tool exactly as if the model had called it. This is how the
   * POS (or a demo script) edits an order by hand — same reducer, same fan-out,
   * so the table screen and the kitchen see it identically.
   */
  applyToolDirect(name, args = {}, doa = null) {
    // A caller may say where the diner sits; the seat is then created and
    // blended exactly like one heard by the microphone array.
    const seat = typeof doa === 'number' ? this.seats.resolve(doa) : null;
    const changed = this.pack.applyTool(this.state, name, args, { seat, doa });
    if (changed) {
      this.state.seats = this.seats.list();
      this.broadcastUi({ t: 'state', state: this.state });
      // A tool does the same thing whichever side called it. Asking for the bill
      // from the POS used to change the screen and stop there, so a table could
      // sit looking at a bill nobody had made payable.
      if (name === 'request_bill') {
        this.requestPayment().then(() => this.pushPaymentLink());
      }
    }
    return changed;
  }

  setAgentState(state) {
    if (this.agentState === state) return;
    this.agentState = state;
    this.broadcastUi({ t: 'agent_state', state });
    this.sendToDevice({ t: 'agent_state', state });
    this.sendToDevice({ t: 'led', mode: state, doa: this.doa });
  }

  addTranscript(role, text, seat = null) {
    if (!text) return;
    const entry = {
      role,
      text,
      seat: seat?.label || null,
      seatId: seat?.id ?? null,
      angle: seat?.angle ?? null,
      ts: Date.now(),
    };
    this.transcript.push(entry);
    if (this.transcript.length > 200) this.transcript.shift();
    this.broadcastUi({ t: 'transcript', ...entry });
  }

  log(msg) {
    console.log(`[${this.dock}/${this.id}] ${msg}`);
  }

  toJSON() {
    return {
      id: this.id,
      dock: this.dock,
      pack: this.pack.id,
      awake: this.awake,
      agentState: this.agentState,
      deviceOnline: Boolean(this.device),
      device: this.deviceInfo,
      screens: this.uis.size,
      total: this.state.total,
      items: this.state.items?.length ?? 0,
      status: this.state.status,
      people: this.state.people ?? this.seats.list().length,
      waiterCalled: Boolean(this.state.waiterCalled),
      tickets: this.state.tickets || [],
      audio: {
        micFrames: this.micFrames,
        spkFrames: this.spkFrames,
        micSeconds: Number(((this.micFrames * 20) / 1000).toFixed(1)),
        spkSeconds: Number(((this.spkFrames * 20) / 1000).toFixed(1)),
        doa: this.doa === 0xffff ? null : this.doa,
        queued: this.spkQueue.length,
        seats: this.seats.list(),
        framesVad: this.framesVad || 0,
        framesDoa: this.framesDoa || 0,
        framesBoth: this.framesBoth || 0,
        micLevel: this.micLevel,
        suppressed: this.suppressedFrames,
        peakTalking: this.peakWhileTalking,
        peakListening: this.peakWhileListening,
        bargeInLevel: config.bargeInLevel,
      },
    };
  }
}

/** Mean of a set of bearings, taken the long way round so 350 and 10 average to 0. */
/**
 * Reduces a burst of arrival angles to one bearing and a measure of agreement.
 *
 * Returns `{ angle, strength }`, where strength is the mean resultant length
 * R in 0..1 — the length of the average unit vector. R near 1 means every
 * sample pointed the same way; R near 0 means they pointed everywhere and the
 * average is a direction nobody spoke from.
 *
 * That number is the point of this function. A mean always returns something,
 * so the old code committed to an answer whether the samples agreed or not:
 * two people talking over each other averaged to the empty space between them
 * and the dish went to whoever happened to be sitting there. Now the caller
 * can tell "person on the left" from "no idea", and no idea is a legitimate
 * answer — an unattributed dish is a smaller failure than one attributed to
 * the wrong person, who then has to hand it across the table.
 *
 * The angle is a circular *median*: the sample whose total angular distance to
 * the others is smallest. A mean is dragged by a single reflection off a wall
 * or a stray lock on the speaker; a median ignores a minority of outliers
 * entirely. O(n²), on at most a few dozen samples.
 */
function bearingOf(degrees) {
  if (!degrees.length) return null;

  let x = 0;
  let y = 0;
  for (const d of degrees) {
    x += Math.cos((d * Math.PI) / 180);
    y += Math.sin((d * Math.PI) / 180);
  }
  const strength = Math.hypot(x, y) / degrees.length;

  let best = degrees[0];
  let bestCost = Infinity;
  for (const candidate of degrees) {
    let cost = 0;
    for (const other of degrees) cost += angleDistance(candidate, other);
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
    }
  }
  return { angle: Math.round(((best % 360) + 360) % 360), strength };
}

export class SessionManager {
  /** @param {any} pack */
  constructor(pack) {
    this.pack = pack;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
  }

  /** @returns {Session} */
  get(dock) {
    let s = this.sessions.get(dock);
    if (!s) {
      s = new Session(dock, this.pack);
      this.sessions.set(dock, s);
      console.log(`[${dock}] session created ${s.id}`);
    }
    return s;
  }

  /** @returns {Session|undefined} */
  peek(dock) {
    return this.sessions.get(dock);
  }

  list() {
    return [...this.sessions.values()];
  }
}
