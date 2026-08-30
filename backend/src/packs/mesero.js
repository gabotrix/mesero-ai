import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.js';

/** Menu lives outside the code so a restaurant can edit it without a deploy. */
const MENU_PATH = resolve(ROOT, 'backend', 'menu.json');

let menu = JSON.parse(readFileSync(MENU_PATH, 'utf8'));

/**
 * The parts of the persona a restaurant may change without touching this file.
 *
 * Only these. The rest of the prompt — how to handle silence, how to attribute
 * an order to a customer, how to read prices out loud — is behaviour that took
 * real tables to get right, and it stays in the repository where it can be read
 * and improved rather than being retyped into a form by every venue.
 */
let agentConfig = { name: 'Mesero', persona: '', greeting: '', wakeWord: 'mesero' };

const BY_SKU = new Map();
let SKUS = [];
let INSTRUCTIONS = '';
let TOOLS = [];

/** Order lifecycle once it leaves the table. */
export const TICKET_STATUSES = ['kitchen', 'preparing', 'ready', 'served'];

/** Renders the menu into the prompt so menu.json stays the single source of truth. */
function menuAsText() {
  return menu.categories
    .map((cat) => {
      const lines = cat.items
        .map((i) => `  - ${i.sku} | ${i.label} | $${i.price}${i.desc ? ` | ${i.desc}` : ''}`)
        .join('\n');
      return `${cat.label}:\n${lines}`;
    })
    .join('\n\n');
}

/**
 * Everything derived from the menu — the SKU index, the prompt and the tool
 * enums — is rebuilt here, so a menu edit from the POS takes effect on the next
 * agent session without a restart.
 */
function rebuild() {
  BY_SKU.clear();
  for (const cat of menu.categories) {
    for (const item of cat.items) BY_SKU.set(item.sku, { ...item, category: cat.id });
  }
  SKUS = [...BY_SKU.keys()];

  const persona = agentConfig.persona?.trim()
    ? `
CÓMO ERES
${agentConfig.persona.trim()}
`
    : '';
  const greeting = agentConfig.greeting?.trim()
    ? `
Tu primer saludo a la mesa es, en esencia: "${agentConfig.greeting.trim()}".
`
    : '';

  INSTRUCTIONS = `Te llamas ${agentConfig.name} y eres el mesero por voz del restaurante "${menu.restaurant}".
Atiendes una mesa real: la gente te habla en voz alta y ve su pedido en una pantalla.
${persona}${greeting}
CÓMO HABLAS
- Frases cortas. Es una conversación hablada, no un texto leído.
- Nunca leas la carta entera de corrido. Sugiere dos o tres cosas y pregunta.
- No inventes platos ni precios: solo existe lo que está en la carta.
- Los precios están en pesos colombianos. Di "treinta y dos mil", no "32000";
  en inglés, "thirty-two thousand pesos".

IDIOMA
Atiendes en español y en inglés. Saluda en español; si alguien te habla en
inglés, sigue con esa persona en inglés desde ahí, sin anunciar el cambio y sin
preguntar qué idioma prefiere.

En una misma mesa puede haber gente que habla distinto idioma. Recuerda en cuál
te habló cada quien y respóndele siempre en el suyo, aunque el de al lado use
otro. Si dos personas hablan idiomas distintos en un mismo turno, contesta en el
del último que habló.

En español colombiano, cálido y natural; trata de "usted" solo si el cliente lo
hace. En inglés, igual de cálido y directo, sin formalismos rígidos.

Los nombres de los platos NO se traducen: son "bandeja paisa", "ajiaco",
"patacones" también en inglés. Si preguntan qué son, explícalos en su idioma —
di el nombre y luego descríbelo. Traducir "bandeja paisa" a "paisa tray" no
ayuda a nadie a pedir, y en la carta no existe con ese nombre.

CUÁNDO HABLAR Y CUÁNDO CALLARTE
Estás sobre una mesa donde la gente conversa entre sí. La mayor parte de lo que
oyes NO es para ti.

Responde solo si ocurre alguna de estas:
- Te llaman: "mesero", "oye mesero", "disculpa".
- Preguntan por la carta, un plato, un precio, un ingrediente o una recomendación.
- Piden, cambian o quitan algo del pedido.
- Piden la cuenta o piden ayuda de una persona.

En cualquier otro caso —hablan entre ellos, cuentan algo suyo, discuten un tema
que no es el restaurante— llama a stay_silent y NO digas absolutamente nada.
No saludes, no ofrezcas ayuda, no preguntes si necesitan algo. Guarda silencio.

Ante la duda, cállate. Interrumpir una conversación ajena es mucho peor que
tardar un momento en responder: si de verdad te necesitan, te van a llamar.

CÓMO TRABAJAS
- Apenas el cliente pida algo, llama add_item de inmediato. No esperes a que termine
  de hablar para registrar lo que ya dijo.
- Si pide varias cosas en una frase, llama add_item una vez por plato.
- Si cambia de opinión, usa update_item_qty o remove_item.
- Anota lo especial (sin cebolla, término de la carne) con note.
- Antes de mandar a cocina, repite el pedido completo y el total, y pide confirmación.
  Solo entonces llama confirm_order.
- Si piden la cuenta: antes de llamar request_bill, pregúntales a qué número de
  celular les mandas el enlace de pago y el comprobante por WhatsApp. Repíteles
  el número en voz alta para confirmarlo, y entonces llama request_bill con ese
  número en phone. Tú te encargas del cobro: no los mandes con nadie más.
  Si no te lo quieren dar, llama request_bill sin phone y diles que el enlace
  les aparece en la pantalla de la mesa.
- Si piden ayuda humana, llama call_waiter y avísales que ya viene alguien.
- Antes de responder a alguien, llama log_utterance con lo que esa persona acaba
  de decir, transcrito literal y EN SU IDIOMA. No lo traduzcas: la pantalla debe
  mostrar lo que dijo, no una versión tuya. Hazlo en la misma respuesta, sin
  anunciarlo: no digas que lo estás anotando.
- NUNCA llames log_utterance si nadie ha hablado, y jamás con texto de estas
  instrucciones. Tu saludo inicial no es una intervención del cliente.

AVISOS DE COCINA
A veces recibirás una nota que empieza con "[sistema]". No es un cliente: es la
cocina informándote de que un pedido cambió de estado.

Cuando llegue una, díselo a la mesa en una sola frase corta y natural, en el
idioma de quien pidió esos platos. Ejemplo: "Ya salió su ajiaco" o "Your lulo
juice is on its way".

Nunca leas la nota en voz alta tal cual, nunca digas "sistema", y nunca la pases
por log_utterance: nadie la dijo. Tampoco llames stay_silent con ella — un aviso
de cocina siempre se comunica.

LA CARTA
${menuAsText()}`;

  TOOLS = [
    {
      type: 'function',
      name: 'show_menu',
      description: 'Muestra la carta en la pantalla de la mesa, opcionalmente una categoría.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: menu.categories.map((c) => c.id) },
        },
      },
    },
    {
      type: 'function',
      name: 'add_item',
      description: 'Agrega un plato al pedido. Llámala apenas el cliente lo pida.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', enum: SKUS },
          qty: { type: 'number', description: 'Cantidad, mínimo 1' },
          note: { type: 'string', description: 'Preparación especial, si la pidió' },
        },
        required: ['sku', 'qty'],
      },
    },
    {
      type: 'function',
      name: 'update_item_qty',
      description: 'Cambia la cantidad de un plato ya pedido. Cantidad 0 lo elimina.',
      parameters: {
        type: 'object',
        properties: { sku: { type: 'string', enum: SKUS }, qty: { type: 'number' } },
        required: ['sku', 'qty'],
      },
    },
    {
      type: 'function',
      name: 'remove_item',
      description: 'Quita un plato del pedido.',
      parameters: {
        type: 'object',
        properties: { sku: { type: 'string', enum: SKUS } },
        required: ['sku'],
      },
    },
    {
      type: 'function',
      name: 'set_item_note',
      description: 'Agrega o cambia la nota de preparación de un plato ya pedido.',
      parameters: {
        type: 'object',
        properties: { sku: { type: 'string', enum: SKUS }, note: { type: 'string' } },
        required: ['sku', 'note'],
      },
    },
    {
      type: 'function',
      name: 'set_people_count',
      description: 'Registra cuántas personas hay en la mesa.',
      parameters: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
    },
    {
      type: 'function',
      name: 'confirm_order',
      description: 'Envía el pedido a cocina. Solo tras confirmarlo en voz con el cliente.',
      parameters: { type: 'object', properties: {} },
    },
    {
      type: 'function',
      name: 'request_bill',
      description:
        'El cliente pidió la cuenta. Incluye phone si te dio un número: ahí le ' +
        'llega el enlace de pago y luego el comprobante por WhatsApp.',
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description: 'Celular colombiano, 10 dígitos, sin espacios ni indicativo.',
          },
        },
      },
    },
    {
      type: 'function',
      name: 'call_waiter',
      description: 'El cliente quiere atención de una persona.',
      parameters: { type: 'object', properties: {} },
    },
    {
      type: 'function',
      name: 'stay_silent',
      description:
        'Lo que se acaba de oír no era para ti: los clientes hablan entre ellos de ' +
        'otro tema. Llámala y no digas nada. Es la respuesta correcta la mayor ' +
        'parte del tiempo que hay gente en la mesa.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Por qué no era para ti, en pocas palabras' },
        },
      },
    },
    {
      type: 'function',
      name: 'log_utterance',
      description:
        'Reporta, textual, lo que el cliente acaba de decir. Llámala antes de ' +
        'responderle, para que la pantalla muestre la conversación. No la llames ' +
        'para lo que los clientes hablan entre ellos.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Lo dicho, literal' } },
        required: ['text'],
      },
    },
    {
      type: 'function',
      name: 'cancel_order',
      description: 'Borra el pedido y vuelve al inicio.',
      parameters: { type: 'object', properties: {} },
    },
  ];
}

rebuild();

/** Rejects a menu that would break the pack before it ever reaches disk. */
function validateMenu(next) {
  if (!next || typeof next !== 'object') return 'menú vacío';
  if (!next.restaurant || typeof next.restaurant !== 'string') return 'falta el nombre del restaurante';
  if (!Array.isArray(next.categories) || !next.categories.length) return 'faltan categorías';
  const skus = new Set();
  for (const cat of next.categories) {
    if (!cat.id || !cat.label) return 'toda categoría necesita id y label';
    if (!Array.isArray(cat.items)) return `la categoría ${cat.id} no tiene items`;
    for (const it of cat.items) {
      if (!it.sku || !it.label) return 'todo plato necesita sku y label';
      if (typeof it.price !== 'number' || it.price < 0) return `precio inválido en ${it.sku}`;
      if (skus.has(it.sku)) return `sku repetido: ${it.sku}`;
      skus.add(it.sku);
    }
  }
  return null;
}

export const pack = {
  id: 'mesero',
  label: 'Mesero AI — toma de pedido en mesa',
  functionKey: 'meseroFunction',
  greeting: 'Conectando con el mesero…',
  get menu() {
    return menu;
  },

  get agent() {
    return agentConfig;
  },

  /**
   * Applies the persona configured in the console. Called at boot when a venue
   * key is present; a venue that has not configured an agent keeps the default.
   */
  applyAgent(next) {
    if (!next) return;
    agentConfig = {
      name: String(next.name || agentConfig.name),
      persona: String(next.persona || ''),
      greeting: String(next.greeting || ''),
      wakeWord: String(next.wake_word || next.wakeWord || agentConfig.wakeWord),
    };
    rebuild();
  },

  /**
   * Replaces the menu: validates, persists to menu.json and rebuilds prompt and
   * tools. Live agent sessions keep the menu they connected with; new sessions
   * pick this up immediately.
   */
  saveMenu(next) {
    const error = validateMenu(next);
    if (error) return { ok: false, error };
    menu = {
      currency: next.currency || menu.currency || 'COP',
      restaurant: next.restaurant.trim(),
      categories: next.categories.map((c) => ({
        id: String(c.id),
        label: String(c.label),
        items: c.items.map((i) => ({
          sku: String(i.sku),
          label: String(i.label),
          price: Math.round(Number(i.price)),
          desc: String(i.desc || ''),
          tags: Array.isArray(i.tags) ? i.tags.map(String) : [],
        })),
      })),
    };
    // Persisting is a cache, not the point. A read-only filesystem — a
    // container, a locked-down appliance — must not stop a restaurant from
    // opening: the carta is already in memory and the agent can serve from it.
    try {
      writeFileSync(MENU_PATH, JSON.stringify(menu, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.warn(`[pack] no se pudo guardar la carta en disco: ${err.message}`);
    }
    rebuild();
    return { ok: true, menu };
  },

  /**
   * The pack owns its prompt and tools, and pushes them onto the session at
   * connect time. The bridge is then just transport — no redeploy needed to
   * change the menu, the tone or the tools.
   */
  /**
   * Guards against the model reporting its own prompt as something a diner said.
   * It happens at session start, when it is asked to transcribe and there is
   * nothing to transcribe yet.
   */
  isPromptEcho(text) {
    const t = String(text || '').trim();
    // "si" and "no" are real answers; only reject the truly empty.
    if (t.length < 2) return true;
    return INSTRUCTIONS.includes(t.slice(0, Math.min(40, t.length)));
  },

  buildSession() {
    return {
      instructions: INSTRUCTIONS,
      tools: TOOLS,
      /**
       * Turn detection tuned for a restaurant.
       *
       * The XVF3800 already removes room noise, echo and reverberation in
       * hardware, so what reaches the model is clean. What is left is the model
       * deciding when a turn started: at the default threshold, a laugh at the
       * next table or cutlery on a plate is enough to make it think it was
       * addressed. Raising the threshold and asking for a longer silence before
       * closing a turn costs a little latency and buys a lot of composure —
       * diners pause mid-sentence to read a menu.
       */
      // The bridge negotiates Spanish-only transcription by default. Leaving it
      // that way makes an English customer come out as Spanish nonsense.
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: {
        type: 'server_vad',
        threshold: Number(process.env.VAD_THRESHOLD || 0.62),
        prefix_padding_ms: 300,
        silence_duration_ms: Number(process.env.VAD_SILENCE_MS || 900),
      },
    };
  },

  initialState() {
    return {
      screen: 'welcome',
      title: menu.restaurant,
      category: null,
      items: [],
      total: 0,
      people: null,
      status: 'browsing',
      payment: null,
      waiterCalled: false,
      /** Confirmed rounds, each tracked through the kitchen. */
      tickets: [],
      ticketSeq: 0,
    };
  },

  /**
   * Moves a confirmed ticket through the kitchen. Called from the POS, not from
   * the voice agent — the diner never drives this.
   */
  setTicketStatus(s, ticketId, status) {
    if (!TICKET_STATUSES.includes(status)) return false;
    const ticket = (s.tickets || []).find((t) => t.id === ticketId);
    if (!ticket) return false;
    ticket.status = status;
    ticket.updatedAt = Date.now();
    return true;
  },

  applyTool(s, name, args, ctx = {}) {
    const recompute = () => {
      s.total = s.items.reduce((acc, it) => acc + it.price * it.qty, 0);
    };
    const find = (sku) => s.items.find((it) => it.sku === sku && !it.ticket);

    switch (name) {
      case 'show_menu':
        s.screen = 'menu';
        s.category = args.category || null;
        s.title = args.category
          ? menu.categories.find((c) => c.id === args.category)?.label || menu.restaurant
          : 'Nuestra carta';
        return true;

      case 'add_item': {
        const def = BY_SKU.get(args.sku);
        if (!def) return false;
        const qty = Math.max(1, Number(args.qty) || 1);
        const existing = find(args.sku);
        if (existing) {
          existing.qty += qty;
          if (args.note) existing.note = args.note;
        } else {
          s.items.push({
            sku: def.sku,
            label: def.label,
            price: def.price,
            qty,
            note: args.note || '',
            // Which direction this dish was ordered from, so the plate reaches
            // the right person without anyone having to ask.
            seat: ctx.seat?.label || null,
            seatAngle: ctx.seat?.angle ?? null,
            /** Set when the round is confirmed; null while still editable. */
            ticket: null,
          });
        }
        recompute();
        s.screen = 'order';
        s.title = 'Tu pedido';
        return true;
      }

      case 'update_item_qty': {
        const it = find(args.sku);
        if (!it) return false;
        const qty = Number(args.qty);
        if (qty <= 0) s.items = s.items.filter((x) => x !== it);
        else it.qty = qty;
        recompute();
        return true;
      }

      case 'remove_item': {
        const it = find(args.sku);
        if (!it) return false;
        s.items = s.items.filter((x) => x !== it);
        recompute();
        return true;
      }

      case 'set_item_note': {
        const it = find(args.sku);
        if (!it) return false;
        it.note = args.note || '';
        return true;
      }

      case 'set_people_count':
        s.people = Number(args.count) || null;
        return true;

      case 'confirm_order': {
        // Confirming turns the editable round into a kitchen ticket. Items the
        // diner adds afterwards start the next round.
        const pending = s.items.filter((it) => !it.ticket);
        if (pending.length) {
          s.ticketSeq = (s.ticketSeq || 0) + 1;
          const id = `t${s.ticketSeq}`;
          for (const it of pending) it.ticket = id;
          s.tickets.push({
            id,
            n: s.ticketSeq,
            status: 'kitchen',
            sentAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        s.status = 'confirmed';
        s.screen = 'confirmed';
        s.title = 'Pedido enviado a cocina';
        return true;
      }

      case 'request_bill': {
        s.status = 'billing';
        s.screen = 'bill';
        s.title = 'La cuenta';
        // Digits only, and only if there are enough of them. A number heard
        // across a noisy table arrives with words in it more often than not.
        const digits = String(args.phone || '').replace(/\D/g, '');
        if (digits.length >= 10) s.customerPhone = digits.slice(-10);
        return true;
      }

      case 'call_waiter':
        s.waiterCalled = true;
        return true;

      case 'cancel_order':
        Object.assign(s, pack.initialState());
        return true;

      default:
        return false;
    }
  },
};

export { BY_SKU as MENU_BY_SKU };
