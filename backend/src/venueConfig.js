import { config } from './config.js';

/**
 * Pulls this restaurant's configuration from the platform at boot.
 *
 * Without a venue key nothing here runs and the backend behaves exactly as it
 * always did, off the menu.json checked into the repository. That is the path a
 * replicator takes on their first evening, and it has to keep working.
 *
 * With a key, the console becomes the source of truth for the carta, the tables
 * and the agent's persona — which is the difference between one restaurant and
 * a hundred.
 *
 * Offline behaviour is not an afterthought. A restaurant whose internet drops at
 * seven in the evening still has to serve dinner, so a failed fetch is not fatal:
 * `pack.saveMenu()` writes every successful pull to menu.json, which means the
 * file on disk is already the cache. Boot with no internet and the backend comes
 * up on last night's carta instead of not coming up at all.
 */

/**
 * Resolved by an edge function, not by the database directly.
 *
 * Both read past row-level security. The difference is the credential: calling a
 * database function through PostgREST requires the project's anon key, and that
 * key cannot live in an open repository — on this project it also opens the
 * payment and messaging functions. An edge function needs no such key, so a
 * venue key is the only thing a restaurant ever configures.
 */
function fnUrl(name) {
  return `https://${config.supabase.projectRef}.supabase.co/functions/v1/${name}`;
}

/**
 * @returns {Promise<{ok:boolean, source:string, venue?:object, agent?:object, docks?:Array, reason?:string}>}
 */
export async function loadVenueConfig(pack) {
  if (!config.venueKey) return { ok: false, source: 'local', reason: 'sin llave de venue' };
  if (!config.supabase.projectRef) {
    return { ok: false, source: 'local', reason: 'sin SUPABASE_PROJECT_REF' };
  }

  let data;
  try {
    // A restaurant opening its doors cannot wait on a hung socket.
    const res = await fetch(fnUrl('venue-config'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ venueKey: config.venueKey }),
      signal: AbortSignal.timeout(8000),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(String(data.error || res.status));
  } catch (err) {
    return { ok: false, source: 'cache', reason: err.message };
  }

  // An empty carta upstream would wipe the working one on disk. A venue that has
  // not finished setting itself up should fall back, not go mute.
  const hasMenu = data.menu?.categories?.some((c) => c.items?.length);
  if (hasMenu && pack.saveMenu) {
    const saved = pack.saveMenu(data.menu);
    if (!saved.ok) return { ok: false, source: 'cache', reason: `carta inválida: ${saved.error}` };
  }

  if (data.agent && pack.applyAgent) pack.applyAgent(data.agent);

  return {
    ok: true,
    source: 'platform',
    venue: data.venue,
    brand: data.brand || null,
    agent: data.agent,
    docks: data.docks || [],
    menuApplied: Boolean(hasMenu),
  };
}
