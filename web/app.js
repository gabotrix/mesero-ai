/**
 * Table screen.
 *
 * A display, not a client. It never opens the microphone and never talks to the
 * gadget — iOS Safari has neither Web Bluetooth nor Web Serial, and it drops mic
 * permission when the screen locks. One WebSocket to the backend, matched to a
 * table by the `dock` the NFC tag encodes, is the whole contract.
 *
 * It shows one thing at a time. The agent decides what that thing is: it takes
 * an order and the order appears, it asks for the bill and the payment step
 * appears. Nobody has to find anything on this screen, which is the point —
 * their hands are busy and their attention is on the table, not here.
 */

const params = new URLSearchParams(location.search);
const DOCK = params.get('dock') || 'mesa-01';
const el = (id) => document.getElementById(id);

const ui = {
  place: el('place'), dockLabel: el('dockLabel'),
  statusChip: el('statusChip'), connectionLabel: el('connectionLabel'), btnPower: el('btnPower'),
  stateLine: el('stateLine'), assistantHint: el('assistantHint'),
  avatar: el('avatar'), avatarMini: el('avatarMini'),
  seatRing: el('seatRing'), suggestions: el('suggestions'),
  steps: el('steps'), btnBack: el('btnBack'),
  viewMenu: el('viewMenu'), categoryList: el('categoryList'), menuList: el('menuList'),
  viewOrder: el('viewOrder'), orderCard: el('orderCard'), orderTotal: el('orderTotal'),
  viewPayment: el('viewPayment'), payTotal: el('payTotal'),
  phoneInput: el('phoneInput'), phoneHint: el('phoneHint'), btnPayNow: el('btnPayNow'),
  payLinkBox: el('payLinkBox'), payNote: el('payNote'), payLink: el('payLink'), paySandbox: el('paySandbox'),
  viewSummary: el('viewSummary'), summaryTitle: el('summaryTitle'), summaryText: el('summaryText'),
  receipt: el('receipt'),
  btnWaiter: el('btnWaiter'), btnMenu: el('btnMenu'), btnBill: el('btnBill'),
  toast: el('toast'), toastText: el('toastText'),
};

ui.dockLabel.textContent = (DOCK.match(/\d+/)?.[0] || DOCK).padStart(2, '0');

const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const prettyPhone = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6)].filter(Boolean).join(' ');
};
const esc = (v) => String(v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATE_COPY = {
  offline: ['Mesa desconectada', 'Avisa al personal. La pantalla se reconecta sola.'],
  idle: ['Mesero en pausa', 'Enciéndelo con el botón, o solo di «mesero».'],
  listening: ['Te estoy escuchando', 'Cuéntame qué quieres ordenar o pregúntame por la carta.'],
  thinking: ['Un momento', 'Estoy preparando tu respuesta.'],
  talking: ['El mesero responde', 'Puedes interrumpirlo cuando quieras.'],
};

const TICKET_LABELS = {
  kitchen: 'Enviado a cocina',
  preparing: 'En preparación',
  ready: 'Listo para servir',
  served: 'Servido',
};

const VIEWS = ['welcome', 'menu', 'order', 'payment', 'summary'];
const STEPS = [
  { id: 'welcome', label: 'Bienvenida' },
  { id: 'menu', label: 'La carta' },
  { id: 'order', label: 'Pedido' },
  { id: 'kitchen', label: 'Cocina' },
  { id: 'payment', label: 'Cuenta' },
];

const model = {
  menu: null, state: null, seats: [],
  awake: false, deviceOnline: false, agentState: 'idle',
  doa: null, activeCategory: 0,
  view: 'welcome',
  /** What the state looked like last time we considered changing the view. */
  cue: { screen: null, count: null, pay: null },
  payPending: false,
};

let socket;
let reconnectDelay = 800;
let toastTimer;

// ------------------------------------------------------------------- socket

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ui?dock=${encodeURIComponent(DOCK)}`);
  socket.onopen = () => { reconnectDelay = 800; };
  socket.onerror = () => socket.close();
  socket.onclose = () => {
    model.deviceOnline = false;
    renderAssistant();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.8, 10000);
  };
  socket.onmessage = ({ data }) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    handleMessage(m);
  };
}

function send(action, extra = {}) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ t: 'ui_action', action, ...extra }));
  }
}

function handleMessage(m) {
  if (m.t === 'snapshot') {
    model.menu = m.menu || model.menu;
    model.state = m.state || model.state;
    model.seats = m.state?.seats || [];
    model.agentState = m.agentState || 'idle';
    model.deviceOnline = Boolean(m.deviceOnline);
    model.awake = Boolean(m.awake);
    model.doa = Number.isFinite(m.doa) && m.doa !== 0xffff ? m.doa : null;
    if (m.menu?.restaurant) ui.place.textContent = m.menu.restaurant;
    // A reload mid-meal should land where the table already was, not on the
    // welcome screen it walked past twenty minutes ago.
    readCue();
    setView(viewForState(), { silent: true });
    renderAll();
    return;
  }
  if (m.t === 'state') {
    model.state = m.state || model.state;
    model.seats = m.state?.seats || model.seats;
    follow();
    renderAll();
    return;
  }
  if (m.t === 'agent_state') { model.agentState = m.state; renderAssistant(); }
  if (m.t === 'device') { model.deviceOnline = Boolean(m.online); renderAssistant(); }
  if (m.t === 'awake') { model.awake = Boolean(m.awake); renderAssistant(); }
  if (m.t === 'doa') { model.doa = m.doa === 0xffff ? null : m.doa; renderSeats(); }
  if (m.t === 'paid') { showToast('Pago recibido. ¡Gracias!'); }
  if (m.t === 'reset') {
    model.seats = [];
    model.cue = { screen: null, count: null, pay: null };
    model.payPending = false;
    setView('welcome');
    renderAll();
  }
}

// -------------------------------------------------------------- guided flow

function itemCount() {
  return (model.state?.items || []).reduce((n, it) => n + (it.qty || 1), 0);
}

/** The three things in the table state that are worth changing the screen for. */
function readCue() {
  model.cue = {
    screen: model.state?.screen || null,
    count: itemCount(),
    pay: model.state?.payment?.status || null,
  };
}

function viewForState() {
  const s = model.state;
  if (!s) return 'welcome';
  if (s.payment?.status === 'paid') return 'summary';
  if (s.payment) return 'payment';
  if (itemCount() > 0) return 'order';
  if (s.screen === 'menu') return 'menu';
  return 'welcome';
}

/**
 * Follow the conversation, but only when something actually happened.
 *
 * Every ticket tick rebroadcasts the whole table state, and re-deriving the view
 * from it each time would yank the screen back to the order while somebody is
 * halfway through reading the dessert menu. So we move on the *edge* — a dish
 * was added, the agent opened the carta, a payment appeared — and otherwise let
 * whoever is holding the phone stay where they are.
 */
function follow() {
  const prev = model.cue;
  const now = {
    screen: model.state?.screen || null,
    count: itemCount(),
    pay: model.state?.payment?.status || null,
  };
  model.cue = now;

  // A payment outranks everything: it is the only step with a deadline.
  if (now.pay !== prev.pay && now.pay) {
    model.payPending = false;
    setView(now.pay === 'paid' ? 'summary' : 'payment');
    return;
  }
  if (now.count !== prev.count && now.count > 0) { setView('order'); return; }
  if (now.screen !== prev.screen && now.screen === 'menu') setView('menu');
}

function setView(next, { silent = false } = {}) {
  if (!VIEWS.includes(next)) return;
  const changed = model.view !== next;
  model.view = next;
  document.body.classList.remove(...VIEWS.map((v) => `view-${v}`));
  document.body.classList.add(`view-${next}`);

  ui.viewMenu.hidden = next !== 'menu';
  ui.viewOrder.hidden = next !== 'order';
  ui.viewPayment.hidden = next !== 'payment';
  ui.viewSummary.hidden = next !== 'summary';
  ui.btnBack.hidden = next === 'welcome';
  ui.steps.hidden = next === 'welcome';

  if (changed && !silent) window.scrollTo({ top: 0, behavior: 'smooth' });
  renderSteps();
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderAssistant();
  renderSteps();
  renderSeats();
  renderMenu();
  renderOrder();
  renderPayment();
  renderSummary();
}

function currentState() {
  if (!model.deviceOnline) return 'offline';
  if (!model.awake) return 'idle';
  return model.agentState;
}

function renderAssistant() {
  const state = currentState();
  document.body.className = `state-${state} view-${model.view}`;
  const copy = STATE_COPY[state] || STATE_COPY.idle;
  ui.stateLine.textContent = copy[0];
  ui.assistantHint.textContent = copy[1];
  ui.connectionLabel.textContent =
    state === 'offline' ? 'Sin gadget' : state === 'idle' ? 'En pausa' : 'Asistente activo';
  ui.btnPower.title = model.awake ? 'Apagar el mesero' : 'Encender el mesero';
  renderAvatar(state);
  renderSeats();
}

/**
 * The agent has a face, from gabotrix-orb-dialogue: the video runs while it
 * speaks and freezes while it listens. Motion is the cue, so nobody has to read
 * a label to know whose turn it is. Both copies move together — on a phone the
 * big one is hidden and the header carries it.
 */
function renderAvatar(state) {
  for (const video of [ui.avatar, ui.avatarMini]) {
    if (!video) continue;
    if (state === 'talking') {
      video.play().catch(() => {});
    } else {
      video.pause();
      if (state === 'idle' || state === 'offline') video.currentTime = 0;
    }
  }
}

/** Which customer the array is hearing right now. */
function activeSeatId() {
  if (model.doa == null || !model.seats.length) return null;
  let best = null;
  let bestDist = 999;
  for (const s of model.seats) {
    const d = Math.min(Math.abs(s.angle - model.doa), 360 - Math.abs(s.angle - model.doa));
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return bestDist <= 45 ? best.id : null;
}

/** Customers drawn at the bearing the array measured for each of them. */
function renderSeats() {
  const active = activeSeatId();
  const R = 118;
  ui.seatRing.innerHTML = model.seats.map((seat) => {
    const rad = (seat.angle * Math.PI) / 180;
    const x = Math.round(R * Math.sin(rad));
    const y = Math.round(-R * Math.cos(rad));
    return `<div class="seat${active === seat.id ? ' active' : ''}" style="transform:translate(${x}px,${y}px)">
      <span>${esc(seat.id)}</span><small>${esc(seat.label)}</small>
    </div>`;
  }).join('');
}

/** The stage of the meal, derived from its state so the two cannot disagree. */
function currentStep() {
  const s = model.state;
  if (model.view === 'payment' || model.view === 'summary') return 4;
  if (!s) return 0;
  if (s.payment || s.status === 'billing') return 4;
  if ((s.tickets || []).length) return 3;
  if (itemCount() > 0) return 2;
  if (model.view === 'menu' || s.screen === 'menu') return 1;
  return 0;
}

function renderSteps() {
  const cur = currentStep();
  ui.steps.innerHTML = STEPS.map((st, i) => {
    const cls = i < cur ? 'done' : i === cur ? 'active' : '';
    return `<div class="step ${cls}">
      <div class="bubble">${i < cur ? '✓' : i + 1}</div>
      <div class="label">${esc(st.label)}</div>
    </div>`;
  }).join('');
}

function renderMenu() {
  const menu = model.menu;
  if (!menu?.categories?.length) {
    ui.categoryList.innerHTML = '';
    ui.menuList.innerHTML = '<div class="empty-state">La carta se está cargando.</div>';
    return;
  }
  if (model.activeCategory >= menu.categories.length) model.activeCategory = 0;

  ui.categoryList.innerHTML = menu.categories.map((c, i) =>
    `<button class="chip${i === model.activeCategory ? ' active' : ''}" data-cat="${i}">${esc(c.label)}</button>`
  ).join('');
  ui.categoryList.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      model.activeCategory = Number(chip.dataset.cat);
      renderMenu();
    });
  });

  const picked = new Set((model.state?.items || []).map((it) => it.sku));
  const cat = menu.categories[model.activeCategory];
  // The photo leads when there is one. A carta somebody reads with their eyes
  // sells differently from a list of names, and the diner is looking at this
  // while deciding — loading is lazy so a long carta does not fetch twenty
  // images nobody scrolled to.
  ui.menuList.innerHTML = (cat.items || []).map((it) => `
    <div class="dish${picked.has(it.sku) ? ' picked' : ''}">
      ${it.image ? `<img class="dish-photo" src="${esc(it.image)}" alt="" loading="lazy">` : ''}
      <div class="body">
        <div class="name">${esc(it.label)}</div>
        ${it.desc ? `<div class="desc">${esc(it.desc)}</div>` : ''}
      </div>
      <div class="price">${money.format(it.price)}</div>
    </div>`).join('');
}

function renderOrder() {
  const items = model.state?.items || [];
  const tickets = model.state?.tickets || [];

  ui.orderCard.innerHTML = items.map((it) => {
    const ticket = tickets.find((t) => t.id === it.ticket);
    const status = TICKET_LABELS[ticket?.status] || 'Pedido recibido';
    const ready = ticket?.status === 'ready' || ticket?.status === 'served';
    // Who asked for it. The array heard the direction; nobody typed it in.
    const who = it.seat ? `<em class="order-who">${esc(it.seat)}</em>` : '';
    return `<article class="order-item">
      <span class="order-qty">${it.qty || 1}</span>
      <div class="order-info">
        <strong>${esc(it.label || it.sku)}</strong>${who}
        <small class="${ready ? 'ready' : ''}">${esc(status)}</small>
      </div>
      <span class="order-price">${money.format((it.price || 0) * (it.qty || 1))}</span>
    </article>`;
  }).join('') || '<div class="empty-state">Aún no has pedido nada.<br>Solo díselo al mesero en voz alta.</div>';

  const total = model.state?.total ?? 0;
  ui.orderTotal.textContent = money.format(total);
  ui.payTotal.textContent = money.format(model.state?.payment?.amount ?? total);
  ui.btnBill.disabled = !items.length;
  ui.btnWaiter.classList.toggle('called', Boolean(model.state?.waiterCalled));
  ui.btnWaiter.textContent = model.state?.waiterCalled ? 'Mesero en camino' : 'Pedir mesero';
}

/**
 * Whatever the backend says about the bill.
 *
 * This runs on every state broadcast, not only after somebody presses the
 * button, because the bill is just as likely to have been asked for out loud —
 * and the previous build only ever drew the link if the button had been used,
 * so a link created by voice was built, logged, and never shown to anybody.
 */
function renderPayment() {
  const pay = model.state?.payment;
  const phone = model.state?.customerPhone;

  if (phone && !ui.phoneInput.value) ui.phoneInput.value = prettyPhone(phone);
  const digits = ui.phoneInput.value.replace(/\D/g, '');
  ui.btnPayNow.disabled = digits.length < 10 || model.payPending;

  if (!pay) {
    ui.payLinkBox.hidden = true;
    ui.btnPayNow.textContent = model.payPending ? 'Generando…' : 'Generar enlace de pago';
    return;
  }

  ui.payLinkBox.hidden = false;
  if (pay.status === 'pending' && pay.url) {
    ui.btnPayNow.textContent = phone ? 'Comprobante a este número' : 'Generar enlace de pago';
    ui.payNote.textContent = `Total a pagar: ${money.format(pay.amount || 0)}`;
    ui.payLink.href = pay.url;
    ui.payLink.hidden = false;
    ui.paySandbox.hidden = !pay.sandbox;
    ui.phoneHint.textContent = phone
      ? `Enviaremos el comprobante y la factura por WhatsApp al ${esc(prettyPhone(phone))}.`
      : 'Déjanos tu número y te enviamos el comprobante y la factura por WhatsApp.';
  } else if (pay.status === 'error') {
    ui.payNote.textContent = pay.message || 'No pudimos generar el enlace. Un mesero te ayuda.';
    ui.payLink.hidden = true;
    ui.paySandbox.hidden = true;
    ui.btnPayNow.textContent = 'Reintentar';
    model.payPending = false;
    ui.btnPayNow.disabled = digits.length < 10;
  } else if (pay.status === 'paid') {
    ui.payLinkBox.hidden = true;
  }
}

function renderSummary() {
  const pay = model.state?.payment;
  if (pay?.status !== 'paid') return;
  const items = model.state?.items || [];
  const phone = model.state?.customerPhone;

  ui.summaryText.textContent = phone
    ? `Tu comprobante va en camino al ${prettyPhone(phone)}.`
    : 'Tu pago fue recibido.';

  ui.receipt.innerHTML = [
    ...items.map((it) => `<div class="line">
      <span>${it.qty || 1} × ${esc(it.label || it.sku)}</span>
      <span>${money.format((it.price || 0) * (it.qty || 1))}</span>
    </div>`),
    `<div class="line"><span>Total pagado</span><span>${money.format(pay.amount || 0)}</span></div>`,
  ].join('');
}

function showToast(text) {
  ui.toastText.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3200);
}

// ------------------------------------------------------------------ actions

ui.btnBack.addEventListener('click', () => setView('welcome'));

ui.btnPower.addEventListener('click', () => send(model.awake ? 'sleep' : 'wake'));

ui.btnWaiter.addEventListener('click', () => {
  send('call_waiter');
  showToast('Listo, un mesero se acercará a tu mesa.');
});

ui.btnMenu.addEventListener('click', () => setView('menu'));
ui.btnBill.addEventListener('click', () => setView('payment'));

ui.suggestions.querySelectorAll('.suggestion').forEach((btn) => {
  btn.addEventListener('click', () => {
    // Voice is the interface; a tap here just gives the agent the same line, so
    // the answer still comes out of the gadget and the whole table hears it.
    send('say', { text: btn.dataset.say });
    if (!model.awake) send('wake');
  });
});

/** Colombian mobiles are ten digits; group them so a typo is visible. */
ui.phoneInput.addEventListener('input', () => {
  const digits = ui.phoneInput.value.replace(/\D/g, '').slice(0, 10);
  ui.phoneInput.value = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)]
    .filter(Boolean).join(' ');
  ui.btnPayNow.disabled = digits.length < 10 || model.payPending;
});

ui.btnPayNow.addEventListener('click', () => {
  const phone = ui.phoneInput.value.replace(/\D/g, '');
  if (phone.length < 10) return;
  model.payPending = true;
  ui.btnPayNow.disabled = true;
  ui.btnPayNow.textContent = 'Generando…';
  if (!model.state?.payment) {
    ui.payLinkBox.hidden = false;
    ui.payNote.textContent = 'Generando el enlace de pago…';
    ui.payLink.hidden = true;
    ui.paySandbox.hidden = true;
  }
  send('pay', { phone });
  // The backend answers with a state broadcast either way; this is only so the
  // button cannot sit greyed out forever if the bridge is having a bad day.
  setTimeout(() => { model.payPending = false; renderPayment(); }, 12000);
});

/**
 * Wear the restaurant's colours, not ours.
 *
 * Applied by overwriting the two tokens the whole stylesheet is built on, so a
 * restaurant changing its brand in the console changes this screen on the next
 * load — no rebuild, no redeploy, nothing to reflash.
 */
async function applyBrand() {
  try {
    const res = await fetch('/api/brand');
    const { brand } = await res.json();
    if (!brand) return;

    const root = document.documentElement.style;
    const set = (k, v) => v && root.setProperty(k, v);

    if (brand.primary) {
      const p = hexToHsl(brand.primary);
      if (p) {
        // The whole stylesheet hangs off these. Setting only --primary left the
        // header and the buttons in our red, because the gradients were written
        // out by hand rather than derived — so derive the family here.
        set('--primary', hsl(p));
        set('--primary-light', hsl({ ...p, l: Math.min(p.l + 11, 92) }));
        set('--primary-dark', hsl({ ...p, l: Math.max(p.l - 14, 8) }));
        set('--foreground', hsl({ ...p, l: 20 }));
        set('--gradient-primary',
          `linear-gradient(135deg, hsl(${hsl({ ...p, l: Math.max(p.l - 14, 8) })}), hsl(${hsl(p)}))`);
        set('--gradient-glow',
          `radial-gradient(circle at 50% 50%, hsl(${hsl(p)} / 0.2), transparent 70%)`);
        set('--glass-border', `${hsl(p)} / 0.2`);
        set('--glass-shadow', `${hsl({ ...p, l: 20 })} / 0.1`);
        for (const [name, blur, alpha] of [['sm', '2px 8px', 0.08], ['md', '8px 24px', 0.12], ['lg', '16px 48px', 0.16]]) {
          set(`--shadow-${name}`, `0 ${blur} hsl(${hsl({ ...p, l: 20 })} / ${alpha})`);
        }
      }
    }

    if (brand.secondary) {
      const c = hexToHsl(brand.secondary);
      if (c) {
        set('--secondary', hsl(c));
        set('--accent', hsl(c));
        set('--gradient-accent',
          `linear-gradient(135deg, hsl(${hsl(c)}), hsl(${hsl({ ...c, l: Math.max(c.l - 10, 8) })}))`);
        set('--shadow-accent', `0 10px 40px -10px hsl(${hsl(c)} / 0.4)`);
      }
    }

    if (brand.logoUrl) {
      const mark = document.querySelector('.brand-mark');
      if (mark) {
        mark.innerHTML = '';
        const img = document.createElement('img');
        img.src = brand.logoUrl;
        img.alt = '';
        img.style.cssText = 'width:100%;height:100%;object-fit:contain';
        mark.appendChild(img);
      }
    }
    if (brand.name) document.title = `${brand.name} · Mesero AI`;
  } catch {
    /* the screen works in our colours; it is not worth failing over */
  }
}

const hsl = (c) => `${c.h} ${c.s}% ${c.l}%`;

/** The stylesheet is written in HSL components, so a hex has to be converted. */
function hexToHsl(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((v) => parseInt(v, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

applyBrand();
setView('welcome', { silent: true });
renderAll();
connect();
