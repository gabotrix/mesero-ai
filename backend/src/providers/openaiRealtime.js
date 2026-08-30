import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * Realtime provider that talks straight to OpenAI, with no bridge in between.
 *
 * This is the "bring your own credential" path. The hosted GABOTRIX bridge is
 * the default because it removes four account signups from the setup, but a
 * default that cannot be replaced is a lock-in, and a project nobody can run
 * without us is not open source in any way that matters. So: same interface,
 * same events, one environment variable apart.
 *
 *   PROVIDER=openai
 *   OPENAI_API_KEY=sk-...
 *
 * Note this holds a vendor key in the restaurant's own process, which is exactly
 * what the bridge exists to avoid. That trade is the point — you choose who
 * holds the secret.
 *
 * Uses the `ws` client rather than Node's built-in WebSocket because the
 * built-in one cannot send an Authorization header.
 */
export class OpenAIRealtimeProvider extends EventEmitter {
  /**
   * @param {{apiKey:string, model:string, baseUrl?:string,
   *          sessionOverride?:{instructions:string, tools:Array}|null}} opts
   */
  constructor({ apiKey, model, baseUrl = 'wss://api.openai.com/v1/realtime', sessionOverride = null }) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.sessionOverride = sessionOverride ? { ...sessionOverride } : null;
    this.overrideRetries = 0;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.ready = false;
    this.closed = false;
  }

  get url() {
    return `${this.baseUrl}?model=${encodeURIComponent(this.model)}`;
  }

  connect() {
    if (this.ws) return;
    const ws = new WebSocket(this.url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    this.ws = ws;

    ws.on('open', () => {
      // Unlike the bridge, nothing here negotiates a session for us: the persona
      // and tools have to go up before the first word of audio.
      this.#raw({
        type: 'session.update',
        session: { type: 'realtime', ...(this.sessionOverride || {}) },
      });
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

    ws.on('error', () => {
      this.emit('error', new Error('realtime transport error'));
    });

    ws.on('close', (code, reason) => {
      this.ready = false;
      this.ws = null;
      if (!this.closed) this.emit('closed', { code, reason: String(reason || '') });
    });
  }

  #handle(msg) {
    switch (msg.type) {
      case 'session.updated':
        if (!this.ready) {
          this.ready = true;
          this.emit('ready');
        }
        return;

      case 'error': {
        // Same failure the bridge hits: one unrecognised field rejects the whole
        // session.update and takes the persona down with it. Drop it and retry.
        const text = msg.error?.message || 'realtime error';
        const unknown = String(text).match(/Unknown parameter:\s*'session\.([^'.]+)/i);
        if (unknown && this.sessionOverride && this.overrideRetries < 4) {
          const field = unknown[1];
          if (field in this.sessionOverride) {
            this.overrideRetries++;
            delete this.sessionOverride[field];
            console.log(`[provider] dropped unsupported session.${field}, retrying`);
            this.#raw({
              type: 'session.update',
              session: { type: 'realtime', ...this.sessionOverride },
            });
            return;
          }
        }
        this.emit('error', new Error(text));
        return;
      }

      // The audio event was renamed between the beta and the GA API and both
      // shapes are still in the wild depending on the model pinned.
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (msg.delta) this.emit('audio', Buffer.from(msg.delta, 'base64'));
        return;

      case 'input_audio_buffer.speech_started':
        this.emit('interrupted');
        return;

      case 'response.done':
        this.emit('turn_end');
        return;

      case 'response.function_call_arguments.done': {
        let args = {};
        try {
          args = msg.arguments ? JSON.parse(msg.arguments) : {};
        } catch {
          /* the model occasionally emits malformed JSON; an empty call is
             better than throwing inside the socket handler */
        }
        this.emit('tool', { id: msg.call_id, name: msg.name, args });
        // Nothing upstream waits on a result, but a call left unanswered keeps
        // the model's turn open and it stops speaking.
        this.#raw({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: msg.call_id,
            output: JSON.stringify({ ok: true }),
          },
        });
        return;
      }

      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) this.emit('transcript', { role: 'user', text: msg.transcript });
        return;

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (msg.transcript) this.emit('transcript', { role: 'assistant', text: msg.transcript });
        return;

      default:
    }
  }

  #raw(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  /** @param {Buffer} pcm PCM16LE mono at the provider sample rate */
  sendAudio(pcm) {
    if (!this.ready) return;
    this.#raw({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  /** Injects a user turn as text — used by UI buttons such as "call the waiter". */
  sendText(text) {
    if (!this.ready) return;
    this.#raw({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.#raw({ type: 'response.create' });
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
