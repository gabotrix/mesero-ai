import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundled to CommonJS for the desktop build, import.meta is empty. ROOT does
// not depend on this in that case, but evaluating it would still throw.
const here = import.meta.url ? dirname(fileURLToPath(import.meta.url)) : process.cwd();

/**
 * Where the editable files live: the menu, the .env, the web assets.
 *
 * Three answers, because this runs in three shapes. From the repository it is
 * the repository. Packaged as a desktop program it is the folder holding the
 * executable — `import.meta.url` there points inside a virtual filesystem the
 * restaurant cannot open, so a menu edit would vanish on the next launch. And
 * MESERO_ROOT wins over both, which is what the appliance service on the
 * reComputer uses to keep its data outside the install directory.
 */
const runningPackaged =
  Boolean(process.pkg) || !/^node(\.exe)?$/i.test(basename(process.execPath));

export const ROOT = process.env.MESERO_ROOT
  ? resolve(process.env.MESERO_ROOT)
  : runningPackaged
    ? dirname(process.execPath)
    : resolve(here, '..', '..');

/** Minimal .env loader — avoids a dependency for three variables. */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvFile(resolve(ROOT, '.env'));

export const config = {
  port: Number(process.env.PORT || 8787),

  /**
    * Which agent pack to run.
    *
    * A pack owns the prompt, the tools the model may call, and how a tool call
    * changes the screen. Nothing else in the stack knows what is being sold,
    * which is what makes this a voice-ordering platform rather than a
    * restaurant app — but only `mesero` ships here.
    */
  pack: process.env.PACK || 'mesero',

  /**
   * Which voice backend to use: 'gabotrix' | 'openai' | 'local'.
   *
   * A restaurant chooses this in the console, and the console shows what to set
   * here. Anything other than the default means the credential — or the machine
   * — is yours, which also means you are hosting this backend yourself. That is
   * not a restriction, it is arithmetic: we cannot reach a model on your LAN.
   */
  provider: (process.env.PROVIDER || 'gabotrix').toLowerCase(),

  /**
   * Identifies this restaurant to the voice service, and to the carta, the
   * tables and the agent that come with it. The only thing a `gabotrix`
   * deployment configures.
   *
   * Empty is legal — the backend then runs on the carta committed in this
   * repository, which is enough to hear it work.
   */
  venueKey: process.env.VENUE_KEY || '',

  /** Only read when PROVIDER=openai. */
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
    baseUrl: process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime',
  },

  /**
   * Only read when PROVIDER=local. Speaks the envelope in docs/voz-local.md,
   * which is the same one the hosted bridge speaks.
   */
  localVoice: {
    url: process.env.LOCAL_VOICE_URL || 'ws://localhost:8080/voice',
    token: process.env.LOCAL_VOICE_TOKEN || '',
  },

  /**
   * Where the voice service lives. A hostname, not a secret.
   *
   * There is no credential here on purpose. The only thing that identifies a
   * caller is its venue key: that is the whole point of issuing one, and adding
   * a second token would just be something else to lose.
   */
  supabase: {
    projectRef: process.env.SUPABASE_PROJECT_REF || 'ecxsbvmmpwpjjyrufykr',
    /** Only for a self-hosted service that fronts its functions with one. */
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    /**
     * Edge function that bridges to the realtime model. It is pure transport:
     * each agent pack pushes its own prompt and tools onto the session at
     * connect time, so changing the menu or the persona needs no redeploy.
     */
    bridgeFunction: process.env.SUPABASE_BRIDGE_FUNCTION || 'gemini-live',
  },

  /** Sample rate the realtime provider speaks. The device always speaks 16 kHz. */
  providerRate: Number(process.env.PROVIDER_RATE || 24000),

  /**
   * RMS a frame must reach to interrupt the agent mid-sentence. Echo residue and
   * room noise sit well below this; a person speaking up is far above it.
   */
  bargeInLevel: Number(process.env.BARGE_IN_LEVEL || 2500),

  /**
   * Consecutive frames the array must call speech before we cut the agent off.
   *
   * Frames are 20 ms, so four is 80 ms — under a tenth of a second, which is
   * faster than a person notices, and long enough that a cough or a plate does
   * not stop a sentence.
   */
  bargeInFrames: Number(process.env.BARGE_IN_FRAMES || 4),

  /**
   * How long echo is still assumed present after the last frame is handed to the
   * gadget. It covers the device's jitter buffer and I2S DMA — roughly 200 ms of
   * audio that has been sent but not yet heard — plus the tail in the room.
   */
  echoGuardMs: Number(process.env.ECHO_GUARD_MS || 800),

  /**
   * Bearings needed before a direction counts as measured. One frame of azimuth
   * is noise; ten is a person.
   */
  bearingMinSamples: Number(process.env.BEARING_MIN_SAMPLES || 10),
  /**
   * How much the samples in a turn must agree before we name a customer.
   *
   * The mean resultant length, 0..1. Below this the turn is left
   * unattributed rather than guessed. 0.85 is roughly "the samples span
   * about a quarter-turn or less" — loose enough for somebody who moves
   * while talking, tight enough to reject two people at once.
   */
  bearingMinStrength: Number(process.env.BEARING_MIN_STRENGTH || 0.85),

  /**
   * Bearings kept per utterance — 30 frames is 600 ms, about one sentence.
   * A longer window spans a change of speaker, and the circular mean of two
   * people sitting apart lands where neither of them is.
   */
  bearingWindow: Number(process.env.BEARING_WINDOW || 30),

  /**
   * Frames handed to the gadget before delivery settles into real time. This is
   * the cushion that absorbs network jitter; too small and playback runs dry
   * mid-sentence.
   */
  primeFrames: Number(process.env.PRIME_FRAMES || 10),

  /** How long the agent stays mute after deciding a turn was not for it. */
  silenceHoldMs: Number(process.env.SILENCE_HOLD_MS || 2500),

  /** Speech frames needed to wake a sleeping table. 40 frames is 800 ms. */
  wakeVadFrames: Number(process.env.WAKE_VAD_FRAMES || 40),

  /** Grace after the last dish is served before the table puts itself to sleep. */
  serveSleepMs: Number(process.env.SERVE_SLEEP_MS || 25000),

  /** What the agent is told to pass on when the kitchen moves a ticket. */
  ticketAnnouncements: {
    preparing: 'La cocina ya está preparando:',
    ready: 'Ya está listo para servir:',
    served: 'Acaban de servir:',
  },
  ticketAnnounceStyle:
    'Avísale a la mesa en una frase corta y natural, en el idioma de quien lo ' +
    'pidió. No leas esta nota ni la registres como algo que dijo un cliente.',

  /** Seconds a session survives after its device drops, so a reconnect keeps the order. */
  sessionGraceSeconds: Number(process.env.SESSION_GRACE_SECONDS || 60),
};

/**
 * Numeric settings the session logic compares against. An undefined one does not
 * throw: `n >= undefined` is simply false, so the feature it guards turns itself
 * off and nothing says a word. Two of these went missing that way — the bearing
 * window and the playback cushion — and both looked like hardware problems.
 */
const REQUIRED_NUMBERS = [
  'port', 'providerRate', 'bargeInLevel', 'bargeInFrames', 'echoGuardMs',
  'bearingMinSamples', 'bearingMinStrength', 'bearingWindow', 'primeFrames', 'sessionGraceSeconds',
  'silenceHoldMs', 'wakeVadFrames', 'serveSleepMs',
];

export function assertConfig() {
  if (!['gabotrix', 'openai', 'local'].includes(config.provider)) {
    throw new Error(`PROVIDER debe ser 'gabotrix', 'openai' o 'local'; llegó '${config.provider}'`);
  }
  if (config.provider === 'openai' && !config.openai.apiKey) {
    throw new Error('PROVIDER=openai necesita OPENAI_API_KEY');
  }
  if (config.provider === 'local' && !config.localVoice.url) {
    throw new Error('PROVIDER=local necesita LOCAL_VOICE_URL');
  }

  const broken = REQUIRED_NUMBERS.filter(
    (k) => typeof config[k] !== 'number' || !Number.isFinite(config[k])
  );
  if (broken.length) {
    throw new Error(
      `Config settings missing or not numeric: ${broken.join(', ')}. ` +
        `Every one of these silently disables a feature when undefined.`
    );
  }

}
