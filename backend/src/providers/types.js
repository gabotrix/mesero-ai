/**
 * A RealtimeProvider owns the conversation with the voice model.
 *
 * It is deliberately narrow so the device and the UI never learn which vendor is
 * behind it. Swapping OpenAI Realtime for Azure or Gemini means writing one new
 * file in this folder and nothing else.
 *
 * Audio in and out is PCM16LE mono at `config.providerRate` (24 kHz today).
 *
 * Events emitted:
 *   'ready'                        session negotiated, safe to send audio
 *   'audio'      (Buffer)          model speech
 *   'interrupted'                  user barged in; flush playback everywhere
 *   'turn_end'                     model finished its turn
 *   'tool'       ({name, args, id}) model called a tool
 *   'transcript' ({role, text})    partial or final transcript
 *   'error'      (Error)
 *   'closed'     ({code, reason})
 */
export const PROVIDER_EVENTS = Object.freeze([
  'ready',
  'audio',
  'interrupted',
  'turn_end',
  'tool',
  'transcript',
  'error',
  'closed',
]);

/**
 * The whole surface a provider has to implement. Four methods and the events
 * above — deliberately small, so that writing one against a different vendor
 * (or a local model) is an afternoon rather than a project.
 *
 * @typedef {import('node:events').EventEmitter & {
 *   connect(): void,
 *   sendAudio(pcm: Buffer): void,
 *   sendText(text: string): void,
 *   close(): void,
 *   ready: boolean,
 * }} RealtimeProvider
 */
