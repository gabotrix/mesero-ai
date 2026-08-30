import { config } from '../config.js';
import { SupabaseEdgeProvider } from './supabaseEdge.js';
import { OpenAIRealtimeProvider } from './openaiRealtime.js';
import { LocalVoiceProvider } from './localVoice.js';

/**
 * Picks the voice backend. Three answers, one environment variable.
 *
 *   gabotrix   paste a venue key and you are done — no vendor accounts, no
 *              credentials on this machine. The default, because asking somebody
 *              to open four accounts before they can hear the thing talk is how
 *              a project stops being replicable.
 *
 *   openai     your own credential, straight to OpenAI. Note it now lives on
 *              this machine, which is exactly what the hosted bridge exists to
 *              avoid — that trade is the point: you choose who holds the secret.
 *
 *   local      a model on your own hardware. The one that keeps working when the
 *              internet does not, which for a restaurant at seven in the evening
 *              is the only argument that matters.
 *
 * The device, the session and the table screen cannot tell which is running.
 * They all implement the same eight-event interface in `types.js`, and a fourth
 * is one file in this folder plus a branch here.
 */
export function createProvider({ sessionOverride = null } = {}) {
  switch (config.provider) {
    case 'openai':
      return new OpenAIRealtimeProvider({
        apiKey: config.openai.apiKey,
        model: config.openai.model,
        baseUrl: config.openai.baseUrl,
        sessionOverride,
      });

    case 'local':
      return new LocalVoiceProvider({
        url: config.localVoice.url,
        token: config.localVoice.token,
        sessionOverride,
      });

    default:
      return new SupabaseEdgeProvider({
        projectRef: config.supabase.projectRef,
        anonKey: config.supabase.anonKey,
        functionName: config.supabase.bridgeFunction,
        venueKey: config.venueKey,
        sessionOverride,
      });
  }
}

/** What to print at boot, so a misconfigured deployment is obvious. */
export function describeProvider() {
  switch (config.provider) {
    case 'openai':
      return `openai (${config.openai.model})`;
    case 'local':
      return `local (${config.localVoice.url})`;
    default:
      return `gabotrix (${config.supabase.bridgeFunction})`;
  }
}
