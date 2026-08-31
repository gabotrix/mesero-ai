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
let agentConfig = {
  name: 'Mesero',
  persona: '',
  greeting: '',
  wakeWord: 'mesero',
  // Which languages this agent serves in, in order. The first is the one it
  // greets in; more than one means it follows whoever it is talking to.
  languages: ['es', 'en'],
};

/**
 * The languages we can name in the prompt, written as the prompt writes them.
 *
 * A restaurant configures a set rather than a single language because that is
 * what a room actually looks like: a table in Cartagena is Spanish and English
 * at once, and the interesting behaviour — answer each person in the language
 * they used — only exists when there is more than one.
 */
const LANGUAGE_NAMES = {
  es: 'español',
  en: 'inglés',
  zh: 'chino mandarín',
  pt: 'portugués',
  fr: 'francés',
  de: 'alemán',
  it: 'italiano',
  ja: 'japonés',
};

/**
 * "español, inglés y chino mandarín" — with the conjunction Spanish actually
 * uses. `y` becomes `e` before a word that starts with an i- sound, so a list
 * ending in "inglés" or "italiano" needs "e inglés", not "y inglés". The prompt
 * is written in Spanish and read by a model that will imitate its register;
 * feeding it broken Spanish is not free.
 */
function enumerateEs(names) {
  if (names.length === 1) return names[0];
  const last = names[names.length - 1];
  const conj = /^(i|hi)(?!e)/i.test(last) ? 'e' : 'y';
  return `${names.slice(0, -1).join(', ')} ${conj} ${last}`;
}

function languageBlock(codes) {
  const list = (Array.isArray(codes) ? codes : []).filter((c) => LANGUAGE_NAMES[c]);
  const langs = list.length ? list : ['es'];
  const names = langs.map((c) => LANGUAGE_NAMES[c]);
  const primary = names[0];

  if (names.length === 1) {
    return `IDIOMA
Atiendes en ${primary}. Saluda y responde siempre en ${primary}.
Si alguien te habla en otro idioma, sigue en ${primary} con amabilidad y usa
frases más simples: es mejor que te entiendan despacio a que cambies a un idioma
en el que la carta no existe.
`;
  }

  return `IDIOMA
Atiendes en ${enumerateEs(names)}. Saluda en ${primary}; si alguien te habla en
otro de esos idiomas, sigue con esa persona en el suyo desde ahí, sin anunciar el
cambio y sin preguntar qué idioma prefiere.

En una misma mesa puede haber gente que habla distinto idioma. Recuerda en cuál
te habló cada quien y respóndele siempre en el suyo, aunque el de al lado use
otro. Si dos personas hablan idiomas distintos en un mismo turno, contesta en el
del último que habló.
`;
}

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
- Los precios están en pesos colombianos. Dilos en palabras, no en cifras:
  "treinta y dos mil", no "32000" — y lo mismo en cualquier otro idioma que uses.

DE QUIEN ES CADA PLATO
Cuando en la mesa hay más de una persona, cada plato va a nombre de quien lo
pidió. Eso es lo que hace que la comida llegue a la mano correcta sin que nadie
levante la voz cuando el mesero se acerca con la bandeja.

Pásale "para" a add_item con el nombre de quien pidió. Si ya lo sabes porque se
presentaron o se nombraron entre ellos, úsalo y no preguntes. Si no lo sabes y
son varios, pregúntalo UNA vez, ligero y al principio: "¿cómo se llaman, para
no revolver los platos?". No lo vuelvas a preguntar después.

Si están solos, o si el plato es para compartir — una picada, una jarra —, no
mandes "para". Compartir es compartir.

Nunca inventes un nombre, y nunca uses "Cliente 1". Si no sabes de quién es,
déjalo sin dueño: un plato sin nombre se resuelve en la mesa, uno con el nombre
equivocado hace que alguien coma lo que no pidió.

LA PANTALLA ES TU SEGUNDA VOZ
Frente a la mesa hay una pantalla y tú eres lo único que la mueve: el comensal
no puede navegarla por su cuenta. Si nombras algo y no lo muestras, la persona
se queda mirando lo que había antes y cree que no le entendiste.

- Nombras una sección ("tenemos varias bebidas") -> show_menu con esa category.
- Nombras un plato concreto ("el ajiaco viene con...") -> show_menu con ese sku.
- Preguntan qué llevan, cuánto va, o piden ver su pedido -> show_order.
- Piden la cuenta o pagar -> request_bill.

Llámalas AUNQUE la carta ya esté abierta y AUNQUE acabes de mostrar eso mismo:
mover la pantalla a lo que estás diciendo nunca sobra.

Muéstralo mientras hablas, no después. Y no narres la pantalla: no digas "mira
la pantalla" ni "te lo muestro ahí" — la persona ya la está viendo. Habla del
plato, no del monitor.

${languageBlock(agentConfig.languages)}
Cálido y natural en cualquiera de ellos: en español colombiano trata de "usted"
solo si el cliente lo hace; en los demás, igual de cálido y directo, sin
formalismos rígidos.

Los nombres de los platos NO se traducen: son "bandeja paisa", "ajiaco",
"patacones" en cualquier idioma. Si preguntan qué son, explícalos en el idioma de
quien pregunta — di el nombre y luego descríbelo. Traducir "bandeja paisa" a
"paisa tray" no ayuda a nadie a pedir, y en la carta no existe con ese nombre.

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
      description:
        'Muestra la carta en la pantalla de la mesa. Con "category" abre esa sección; ' +
        'con "sku" destaca ese plato concreto. Llámala CADA VEZ que nombres una ' +
        'sección o un plato en voz alta, aunque la carta ya esté abierta.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: menu.categories.map((c) => c.id) },
          sku: { type: 'string', enum: SKUS },
        },
      },
    },
    {
      type: 'function',
      name: 'show_order',
      description:
        'Muestra en la pantalla lo que la mesa lleva pedido y el total. Úsala cuando ' +
        'pregunten qué llevan, cuánto va o pidan ver su pedido. No cobra nada.',
      parameters: { type: 'object', properties: {} },
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
          para: {
            type: 'string',
            description:
              'De quién es el plato: su nombre si lo dijo, o cómo se le puede llamar ' +
              '("el de la camisa azul"). Omítelo si están solos o si el plato es para compartir.',
          },
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
      languages: Array.isArray(next.languages) && next.languages.length
        ? next.languages
        : agentConfig.languages,
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
          // Kept through the rewrite. This mapping names every field it copies,
          // so anything new is dropped in silence — which is how the photos
          // reached the backend and never reached a table.
          image: i.image ? String(i.image) : null,
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
      /** One dish the agent is talking about right now, spotlit on the screen. */
      focus: null,
      /**
       * Bumped every time the agent asks for something to be shown.
       *
       * The screen has to distinguish "here is the table state again" from "I
       * just said look at this". Those can be byte-identical — showing the same
       * category twice, or saying "look again" — so the difference cannot be
       * derived from the state; it has to be counted. This is the counter.
       */
      showSeq: 0,
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
    /**
     * Finds the speaker's own line for a dish, not just anybody's.
     *
     * This used to match on sku alone, and that quietly undid the whole point
     * of the project: two people ordering the same lemonade collapsed into one
     * line of two under whoever spoke first, and the second person vanished
     * from their own order. Attribution is the feature — it cannot be defeated
     * by two friends wanting the same drink.
     *
     * Falls back to a seatless line when the speaker is unknown, and to any
     * line as a last resort so "take that off" still works when the bearing
     * was not resolved. Unattributed lines merge with each other, which is
     * right: they are all just "the table".
     */
    const find = (sku, seat = null) => {
      const open = s.items.filter((it) => it.sku === sku && !it.ticket);
      return (
        open.find((it) => (it.seat ?? null) === (seat ?? null)) ??
        (seat ? null : open[0]) ??
        null
      );
    };

    switch (name) {
      case 'show_menu': {
        s.screen = 'menu';
        // A dish implies its section: naming the ajiaco and leaving the screen
        // on desserts is worse than not having moved it at all.
        const bySku = args.sku ? BY_SKU.get(args.sku) : null;
        s.category = args.category || bySku?.category || null;
        s.focus = bySku ? args.sku : null;
        s.title = bySku
          ? bySku.label
          : s.category
            ? menu.categories.find((c) => c.id === s.category)?.label || menu.restaurant
            : 'Nuestra carta';
        s.showSeq = (s.showSeq || 0) + 1;
        return true;
      }

      case 'show_order':
        s.screen = 'order';
        s.focus = null;
        s.showSeq = (s.showSeq || 0) + 1;
        return true;

      case 'add_item': {
        const def = BY_SKU.get(args.sku);
        if (!def) return false;
        const qty = Math.max(1, Number(args.qty) || 1);
        /*
         * Who this is for: the array's bearing when it has one, otherwise what
         * the agent was told.
         *
         * The bearing wins because nobody had to say anything for it — but the
         * XVF3800's direction register is not answering on this build, and a
         * table of four showing every dish under one nameless customer is worse
         * than an agent that asks once and gets it right. A spoken name also
         * reads better than "Cliente 3": the plate arrives and somebody says
         * "esa es la de Juan".
         */
        const spoken = typeof args.para === 'string' ? args.para.trim().slice(0, 24) : '';
        const seat = ctx.seat?.label || spoken || null;
        const existing = find(args.sku, seat);
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
            seat,
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
        const it = find(args.sku, ctx.seat?.label || null) ?? find(args.sku);
        if (!it) return false;
        const qty = Number(args.qty);
        if (qty <= 0) s.items = s.items.filter((x) => x !== it);
        else it.qty = qty;
        recompute();
        return true;
      }

      case 'remove_item': {
        const it = find(args.sku, ctx.seat?.label || null) ?? find(args.sku);
        if (!it) return false;
        s.items = s.items.filter((x) => x !== it);
        recompute();
        return true;
      }

      case 'set_item_note': {
        const it = find(args.sku, ctx.seat?.label || null) ?? find(args.sku);
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
