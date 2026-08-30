import { config } from '../config.js';
import { SupabaseEdgeProvider } from './supabaseEdge.js';

/**
 * Builds the voice backend.
 *
 * There is one today, reached with a venue key, and that is deliberate: it means
 * a person who has just soldered a board can hear the thing talk without opening
 * an account anywhere. The seam is here rather than inlined so a second one is a
 * new file in this folder and a branch in this function — a local model on the
 * appliance is the obvious next one.
 *
 * The provider owns exactly one concern: the conversation with the voice model.
 * It never learns about tables, tickets, seating or payments, which is why the
 * device, the session and the table screen cannot tell which one is running.
 */
export function createProvider({ sessionOverride = null } = {}) {
  return new SupabaseEdgeProvider({
    projectRef: config.supabase.projectRef,
    anonKey: config.supabase.anonKey,
    functionName: config.supabase.bridgeFunction,
    venueKey: config.venueKey,
    sessionOverride,
  });
}

/** What to print at boot, so a misconfigured deployment is obvious. */
export function describeProvider() {
  return `gabotrix (${config.supabase.bridgeFunction})`;
}
