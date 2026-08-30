import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * Realtime provider that speaks to a Supabase Edge Function which in turn
 * bridges to the vendor's realtime API (Azure OpenAI `gpt-realtime` today).
 *
 * Keeping the vendor key inside the edge function means neither this backend nor
 * the device ever holds a model credential — which is exactly what we want on a
 * box sitting in a restaurant.
 *
 * Uses the `ws` client rather than the global WebSocket. The global one only
 * became reliable in Node 22, and this package declares Node 20 — so a container
 * built on node:20 crashed with "WebSocket is not defined" the moment a gadget
 * connected and the session reached for the voice bridge. It passed every local
 * test, on a machine running 22.
 */
export class SupabaseEdgeProvider extends EventEmitter {
  /**
   * @param {{projectRef:string, anonKey:string, functionName:string, venueKey?:string,
   *          sessionOverride?:{instructions:string, tools:Array}|null}} opts
   */
  constructor({ projectRef, anonKey, functionName, venueKey = '', sessionOverride = null }) {
    super();
    this.projectRef = projectRef;
    this.anonKey = anonKey;
    this.functionName = functionName;
    this.venueKey = venueKey;
    // Copied: the retry logic below mutates it when the API rejects a field.
    this.sessionOverride = sessionOverride ? { ...sessionOverride } : null;
    this.overrideSent = false;
    this.overrideRetries = 0;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.ready = false;
    this.closed = false;
  }

  get url() {
    // The venue key is the credential. The service does not check anything else,
    // so nothing else travels — an anon key here would be ceremony, and putting
    // one in an open repository would be worse than ceremony.
    const q = [`venue=${encodeURIComponent(this.venueKey || '')}`];
    if (this.anonKey) q.push(`apikey=${encodeURIComponent(this.anonKey)}`);
    return (
      `wss://${this.projectRef}.supabase.co/functions/v1/${this.functionName}?${q.join('&')}`
    );
  }

  connect() {
    if (this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      // The edge function negotiates the session and answers `setupComplete`.
    };

    ws.onmessage = async (event) => {
      let text;
      if (typeof event.data === 'string') text = event.data;
      else if (event.data instanceof Blob) text = await event.data.text();
      else text = Buffer.from(event.data).toString('utf8');

      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      this.#handle(msg);
    };

    ws.onerror = () => {
      // `onclose` always follows; report there so we emit a single failure.
      this.emit('error', new Error('realtime transport error'));
    };

    ws.onclose = (ev) => {
      this.ready = false;
      this.ws = null;
      if (!this.closed) this.emit('closed', { code: ev.code, reason: ev.reason || '' });
    };
  }

  #handle(msg) {
    if (msg.error) {
      // The realtime API rejects the whole session.update when it does not
      // recognise one field, taking the instructions and tools down with it.
      // Drop the offending field and try again rather than lose the persona.
      const text = String(msg.error);
      const unknown = text.match(/Unknown parameter:\s*'session\.([^'.]+)/i);
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

    if (msg.setupComplete) {
      // The bridge negotiated its own default session and already triggered a
      // greeting. If this pack brings its own persona, cancel that greeting and
      // push ours. Anything the bridge does not recognise it forwards verbatim,
      // so a raw session.update reaches the model untouched.
      //
      // Applying it makes the model emit `session.updated`, which makes the
      // bridge send a second `setupComplete` and a fresh greeting — that is the
      // one we treat as ready. The guard keeps this from looping.
      if (this.sessionOverride && !this.overrideSent) {
        this.overrideSent = true;
        this.#raw({ type: 'response.cancel' });
        this.#raw({
          type: 'session.update',
          session: { type: 'realtime', ...this.sessionOverride },
        });
        return;
      }
      this.ready = true;
      this.emit('ready');
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
      // Barge-in must be handled before anything else in this message.
      if (sc.interrupted) this.emit('interrupted');

      const parts = sc.modelTurn?.parts || [];
      for (const part of parts) {
        const data = part.inlineData?.data;
        if (data) this.emit('audio', Buffer.from(data, 'base64'));
      }

      if (sc.turnComplete && !sc.interrupted) this.emit('turn_end');
      return;
    }

    // Legacy shape: bare base64 audio.
    if (typeof msg.data === 'string') {
      this.emit('audio', Buffer.from(msg.data, 'base64'));
    }
  }

  /** Sends a message the bridge does not interpret, straight through to the model. */
  #raw(obj) {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * Stops the model mid-sentence.
   *
   * Waiting for the model's own turn detection to notice does not work here:
   * while the agent is speaking, the only microphone frames we forward are the
   * ones the array flagged as speech, so what reaches the model is a stream that
   * begins abruptly in the middle of a word — exactly what a voice-activity
   * detector is built to ignore. We have the better detector, in hardware and
   * after echo cancellation. So we decide, and tell the model to stop.
   */
  cancelResponse() {
    this.#raw({ type: 'response.cancel' });
  }

  /**
   * @param {Buffer} pcm PCM16LE mono at the provider sample rate
   */
  sendAudio(pcm) {
    if (!this.ready || this.ws?.readyState !== 1) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=24000' },
        },
      })
    );
  }

  /** Injects a user turn as text — used by UI buttons such as "call the waiter". */
  sendText(text) {
    if (!this.ready || this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify({ textMessage: text }));
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
