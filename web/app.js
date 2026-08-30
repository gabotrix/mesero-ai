import { T, apply as applyI18n, pickLang, setLang, lang, LANGS } from './i18n.js';

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

/** Looked up per render, not frozen at load: the diner can switch language. */
const stateCopy = (state) => [T(`state.${state}.title`), T(`state.${state}.hint`)];

/** Looked up at render time, not frozen at load: the diner can switch language. */
const ticketLabel = (status) => T(`ticket.${status}`) || T('ticket.received');

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
  if (m.t === 'paid') { showToast(T('toast.paid')); }
  if (m.t === 'reset') {
    model.seats = [];
    model.cue = { screen: null, count: null, pay: null, show: 0 };
    model.payPending = false;
    setView('welcome');
    renderAll();
  }
}

// -------------------------------------------------------------- guided flow

function itemCount() {
  return (model.state?.items || []).reduce((n, it) => n + (it.qty || 1), 0);
}

/** What in the table state is worth changing the screen for. */
function readCue() {
  model.cue = {
    screen: model.state?.screen || null,
    count: itemCount(),
    pay: model.state?.payment?.status || null,
    show: model.state?.showSeq || 0,
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
  const s = model.state;
  const now = {
    screen: s?.screen || null,
    count: itemCount(),
    pay: s?.payment?.status || null,
    show: s?.showSeq || 0,
  };
  model.cue = now;

  // A payment outranks everything: it is the only step with a deadline.
  if (now.pay !== prev.pay && now.pay) {
    model.payPending = false;
    setView(now.pay === 'paid' ? 'summary' : 'payment');
    return;
  }

  /*
   * An explicit "show this" beats every inference below it.
   *
   * This used to be derived from the state — move to the carta when `screen`
   * *became* 'menu'. Which meant that once the carta was open, every later
   * request was invisible: asking for the drinks, then a specific dish, then
   * the drinks again are all `screen === 'menu'` and produced no edge. The
   * agent was calling the tool, the backend was setting the category, and the
   * screen sat on whatever it already had. That is not something a state
   * comparison can catch, because the two states are genuinely identical —
   * so the backend counts the requests and we move on the count.
   */
  if (now.show !== prev.show) {
    setView(now.screen === 'order' ? 'order' : 'menu');
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
  const copy = stateCopy(['offline','idle','listening','thinking','talking'].includes(state) ? state : 'idle');
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
    ui.menuList.innerHTML = `<div class="empty-state">${esc(T('menu.loading'))}</div>`;
    return;
  }
  /*
   * The agent's choice wins over the last chip somebody tapped.
   *
   * It is the only one of the two that just spoke. A tap is remembered until
   * the agent says otherwise, which is why this reads the category rather than
   * assigning it: touching a chip still works, and the next thing the agent
   * names still moves the screen off it.
   */
  const wanted = model.state?.category
    ? menu.categories.findIndex((c) => c.id === model.state.category)
    : -1;
  const active = wanted >= 0 ? wanted : Math.min(model.activeCategory, menu.categories.length - 1);
  model.activeCategory = active;

  ui.categoryList.innerHTML = menu.categories.map((c, i) =>
    `<button class="chip${i === active ? ' active' : ''}" data-cat="${i}">${esc(c.label)}</button>`
  ).join('');
  ui.categoryList.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      model.activeCategory = Number(chip.dataset.cat);
      // Taking the agent's pick out of the way, or the next render puts it
      // straight back and the tap looks broken.
      if (model.state) model.state.category = null;
      model.focusShown = null;
      renderMenu();
    });
  });

  const picked = new Set((model.state?.items || []).map((it) => it.sku));
  const focus = model.state?.focus || null;
  const cat = menu.categories[active];
  // The photo leads when there is one. A carta somebody reads with their eyes
  // sells differently from a list of names, and the diner is looking at this
  // while deciding — loading is lazy so a long carta does not fetch twenty
  // images nobody scrolled to.
  ui.menuList.innerHTML = (cat.items || []).map((it) => `
    <div class="dish${picked.has(it.sku) ? ' picked' : ''}${it.sku === focus ? ' focus' : ''}" data-sku="${esc(it.sku)}">
      ${it.image ? `<img class="dish-photo" src="${esc(it.image)}" alt="" loading="lazy">` : ''}
      <div class="body">
        <div class="name">${esc(it.label)}</div>
        ${it.desc ? `<div class="desc">${esc(it.desc)}</div>` : ''}
      </div>
      <div class="price">${money.format(it.price)}</div>
    </div>`).join('');

  /*
   * Bring the dish the agent just named into view — once per naming.
   *
   * Guarded, because renderMenu runs on every ticket tick: without it the page
   * would drag itself back to the same dish every few seconds while somebody
   * is trying to scroll past it.
   */
  if (focus && model.focusShown !== `${focus}:${model.state?.showSeq}`) {
    model.focusShown = `${focus}:${model.state?.showSeq}`;
    const node = ui.menuList.querySelector(`[data-sku="${CSS.escape(focus)}"]`);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function renderOrder() {
  const items = model.state?.items || [];
  const tickets = model.state?.tickets || [];

  ui.orderCard.innerHTML = items.map((it) => {
    const ticket = tickets.find((t) => t.id === it.ticket);
    const status = ticket?.status ? ticketLabel(ticket.status) : T('ticket.received');
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
  }).join('') || `<div class="empty-state">${esc(T('order.empty'))}<br>${esc(T('order.empty.hint'))}</div>`;

  const total = model.state?.total ?? 0;
  ui.orderTotal.textContent = money.format(total);
  ui.payTotal.textContent = money.format(model.state?.payment?.amount ?? total);
  ui.btnBill.disabled = !items.length;
  ui.btnWaiter.classList.toggle('called', Boolean(model.state?.waiterCalled));
  // Rendered from JS, so the data-i18n hook on it is overwritten every pass —
  // it has to ask for its own translation rather than rely on the sweep.
  ui.btnWaiter.textContent = T(model.state?.waiterCalled ? 'btn.waiterOnWay' : 'btn.waiter');
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
    ui.btnPayNow.textContent = T(model.payPending ? 'pay.working.short' : 'pay.cta');
    return;
  }

  ui.payLinkBox.hidden = false;
  if (pay.status === 'pending' && pay.url) {
    ui.btnPayNow.textContent = T(phone ? 'pay.ctaWithPhone' : 'pay.cta');
    ui.payNote.textContent = `Total a pagar: ${money.format(pay.amount || 0)}`;
    ui.payLink.href = pay.url;
    ui.payLink.hidden = false;
    ui.paySandbox.hidden = !pay.sandbox;
    ui.phoneHint.textContent = phone
      ? `Enviaremos el comprobante y la factura por WhatsApp al ${esc(prettyPhone(phone))}.`
      : T('pay.phoneHint');
  } else if (pay.status === 'error') {
    ui.payNote.textContent = pay.message || 'No pudimos generar el enlace. Un mesero te ayuda.';
    ui.payLink.hidden = true;
    ui.paySandbox.hidden = true;
    ui.btnPayNow.textContent = T('pay.retry');
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
  showToast(T('toast.waiter'));
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
  ui.btnPayNow.textContent = T('pay.working.short');
  if (!model.state?.payment) {
    ui.payLinkBox.hidden = false;
    ui.payNote.textContent = T('pay.working');
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

/**
 * A language switch on the table screen.
 *
 * The diner cannot navigate this screen — the agent drives it — so the one
 * control that has to be reachable by hand is the one that decides whether
 * they can read it at all. Three buttons, no dropdown: somebody who landed on
 * the wrong language should not have to read the wrong language to escape it.
 */
function mountLangSwitch() {
  // Inside the row, not the bar: the bar is a positioned stack of glass layers
  // and anything appended to it lands underneath them.
  const host = document.querySelector('.topbar-row') || document.body;
  const box = document.createElement('div');
  box.className = 'lang-switch';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', T('lang.label'));
  const paint = () => {
    box.innerHTML = LANGS.map(
      (l) => `<button data-lang="${l.code}" class="${l.code === lang() ? 'on' : ''}">${l.short}</button>`,
    ).join('');
    box.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        setLang(b.dataset.lang);
        // The markup hooks repaint themselves; anything rendered from JS —
        // the carta, the order, the ticket statuses — has to be asked again.
        renderAll();
        paint();
      }),
    );
  };
  paint();
  host.appendChild(box);
}

setLang(pickLang(), { remember: false });
mountLangSwitch();
applyBrand();
setView('welcome', { silent: true });
renderAll();
connect();
