import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * A voice model running on the restaurant's own hardware.
 *
 * The case for this is not privacy or cost, though it is both. It is that a
 * restaurant with bad internet still has to serve dinner, and every other
 * provider here dies with the WAN.
 *
 * It speaks the same envelope as the hosted bridge, deliberately: anything that
 * already knows how to answer that shape works, and a small adapter in front of
 * whisper.cpp and a local LLM is a hundred lines rather than a rewrite. The
 * contract is in docs/voz-local.md — four message types in, four out.
 *
 *   PROVIDER=local
 *   LOCAL_VOICE_URL=ws://recomputer.local:8080/voice
 *
 * No credential by default. A box on the restaurant's own network reached over
 * its own LAN has nobody to prove itself to; set LOCAL_VOICE_TOKEN if yours
 * disagrees.
 */
export class LocalVoiceProvider extends EventEmitter {
  /**
   * @param {{url:string, token?:string,
   *          sessionOverride?:{instructions:string, tools:Array}|null}} opts
   */
  constructor({ url, token = '', sessionOverride = null }) {
    super();
    this.baseUrl = url;
    this.token = token;
    this.sessionOverride = sessionOverride ? { ...sessionOverride } : null;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.ready = false;
    this.closed = false;
  }

  get url() {
    return this.token
      ? `${this.baseUrl}${this.baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`
      : this.baseUrl;
  }

  connect() {
    if (this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      // The persona and the tools go up first, exactly as they do for the hosted
      // bridge. A local model that ignores them still works; it just answers
      // without knowing the carta.
      this.#raw({ type: 'session.update', session: { type: 'realtime', ...(this.sessionOverride || {}) } });
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      this.#handle(msg);
    });

    ws.on('error', () => this.emit('error', new Error('local voice transport error')));

    ws.on('close', (code, reason) => {
      this.ready = false;
      this.ws = null;
      if (!this.closed) this.emit('closed', { code, reason: String(reason || '') });
    });
  }

  #handle(msg) {
    if (msg.error) {
      this.emit('error', new Error(String(msg.error)));
      return;
    }

    if (msg.setupComplete) {
      if (!this.ready) {
        this.ready = true;
        this.emit('ready');
      }
      return;
    }

    if (msg.toolCall?.functionCalls) {
      for (const fc of msg.toolCall.functionCalls) {
        this.emit('tool', { id: fc.id, name: fc.name, args: fc.args || {} });
      }
      return;
    }

    const sc = msg.serverContent;
    if (sc) {
      // Barge-in first: whatever else this message says is about a turn the
      // diner has already talked over.
      if (sc.interrupted) this.emit('interrupted');
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data) this.emit('audio', Buffer.from(part.inlineData.data, 'base64'));
      }
      if (sc.turnComplete && !sc.interrupted) this.emit('turn_end');
      return;
    }

    if (typeof msg.data === 'string') this.emit('audio', Buffer.from(msg.data, 'base64'));
  }

  #raw(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  /** Stops the model mid-sentence when somebody talks over it. */
  cancelResponse() {
    this.#raw({ type: 'response.cancel' });
  }

  /** @param {Buffer} pcm PCM16LE mono at the provider sample rate */
  sendAudio(pcm) {
    if (!this.ready) return;
    this.#raw({
      realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=24000' } },
    });
  }

  /** Injects a user turn as text — used by UI buttons such as "call the waiter". */
  sendText(text) {
    if (!this.ready) return;
    this.#raw({ textMessage: text });
  }

  close() {
    this.closed = true;
    this.ready = false;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }
}
