/**
 * POS admin panel.
 *
 * Reads the same live stream the table screens read: one /ui WebSocket per dock,
 * discovered through /api/sessions. Everything it *changes* goes over HTTP —
 * ticket status, table reset, menu edits — so the voice path and the admin path
 * never share a channel.
 */

const el = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TICKET_LABELS = { kitchen: 'En cocina', preparing: 'Preparando', ready: 'Listo', served: 'Servido' };
const TICKET_NEXT = { kitchen: 'preparing', preparing: 'ready', ready: 'served' };
const TICKET_ADVANCE = { kitchen: 'Empezar a preparar', preparing: 'Marcar listo', ready: 'Marcar servido' };
const KANBAN_COLS = ['kitchen', 'preparing', 'ready', 'served'];

/** dock → live view of that table */
const boards = new Map();
let selectedDock = null;
let currentView = (location.hash || '#mesas').slice(1);
if (!['mesas', 'cocina', 'carta'].includes(currentView)) currentView = 'mesas';

// ------------------------------------------------------------------ data in

async function discover() {
  try {
    const res = await fetch('/api/sessions');
    const { sessions } = await res.json();
    el('meta').textContent =
      `${sessions.length} mesa(s) · actualizado ${new Date().toLocaleTimeString('es-CO')}`;
    for (const s of sessions) if (!boards.has(s.dock)) watch(s.dock);
  } catch {
    el('meta').textContent = 'sin conexión con el backend';
  }
}

function watch(dock) {
  const board = { dock, state: null, agentState: 'idle', online: false, awake: false };
  boards.set(dock, board);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ui?dock=${encodeURIComponent(dock)}`);
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'snapshot') {
      board.state = m.state; board.agentState = m.agentState;
      board.online = m.deviceOnline; board.awake = m.awake;
    } else if (m.t === 'state') board.state = m.state;
    else if (m.t === 'agent_state') board.agentState = m.state;
    else if (m.t === 'device') board.online = m.online;
    else if (m.t === 'awake') board.awake = m.awake;
    else if (m.t === 'menu') acceptMenu(m.menu);
    else if (m.t === 'reset') { if (board.state) { board.state.items = []; board.state.tickets = []; } }
    else return;
    render();
  };
  ws.onclose = () => {
    boards.delete(dock);
    if (selectedDock === dock) selectedDock = null;
    render();
    setTimeout(discover, 2000);
  };
}

// ---------------------------------------------------------------- actions

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function advanceTicket(dock, ticketId, status) {
  try {
    await post(`/api/dock/${encodeURIComponent(dock)}/ticket/${encodeURIComponent(ticketId)}/status`, { status });
    toast(`${dock} · pedido → ${TICKET_LABELS[status]}`);
  } catch (e) {
    toast(`No se pudo actualizar: ${e.message}`, true);
  }
}

async function resetTable(dock) {
  if (!confirm(`¿Liberar ${dock}? Se borra el pedido y la conversación de la mesa.`)) return;
  try {
    await post(`/api/dock/${encodeURIComponent(dock)}/reset`);
    toast(`${dock} liberada`);
  } catch (e) {
    toast(`No se pudo liberar: ${e.message}`, true);
  }
}

// ------------------------------------------------------------------ mesas

/** One word that tells a manager what the table needs. */
function tableStatus(b) {
  const s = b.state;
  if (!s) return { key: 'offline', label: 'Sin datos' };
  if (s.status === 'billing') return { key: 'billing', label: 'Pidió la cuenta' };
  const open = (s.tickets || []).filter((t) => t.status !== 'served');
  if (open.length) return { key: 'confirmed', label: TICKET_LABELS[open[0].status] };
  if ((s.items || []).some((it) => !it.ticket)) return { key: 'browsing', label: 'Pidiendo' };
  if (b.awake) return { key: 'browsing', label: 'Con clientes' };
  if ((s.items || []).length) return { key: 'confirmed', label: 'Todo servido' };
  return { key: 'free', label: 'Libre' };
}

function renderTables() {
  const list = [...boards.values()].sort((a, b) => a.dock.localeCompare(b.dock));
  el('tablesEmpty').hidden = list.length > 0;
  el('badgeMesas').hidden = !list.length;
  el('badgeMesas').textContent = String(list.length);

  el('tableGrid').innerHTML = list.map((b) => {
    const st = tableStatus(b);
    const s = b.state || {};
    const people = s.people || (s.seats || []).length;
    const items = (s.items || []).reduce((a, it) => a + (it.qty || 1), 0);
    return `<div class="card table-card${selectedDock === b.dock ? ' selected' : ''}" data-dock="${esc(b.dock)}">
      <div class="head">
        <span class="name">${esc(b.dock)}</span>
        <span class="chip ${st.key}"><i class="dot"></i>${esc(st.label)}</span>
      </div>
      <div class="facts">
        <span class="chip ${b.online ? 'free' : 'offline'}">${b.online ? 'Gadget en línea' : 'Sin gadget'}</span>
        ${people ? `<span class="chip">${people} ${people === 1 ? 'persona' : 'personas'}</span>` : ''}
        ${s.waiterCalled ? '<span class="chip waiter">Llamó al mesero</span>' : ''}
      </div>
      <div class="money">
        <span class="items">${items ? `${items} producto(s)` : 'Sin pedido'}</span>
        <span class="amount">${money.format(s.total || 0)}</span>
      </div>
    </div>`;
  }).join('');

  renderDetail();
}

function renderDetail() {
  const panel = el('tableDetail');
  const b = selectedDock ? boards.get(selectedDock) : null;
  if (!b || !b.state) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const s = b.state;
  const st = tableStatus(b);
  const items = s.items || [];
  const tickets = s.tickets || [];

  // Per-diner grouping: this is what lets the runner put the right plate in
  // front of the right person.
  const seats = [...new Set(items.map((it) => it.seat || 'Mesa'))];
  const seatBlocks = seats.map((seat) => {
    const own = items.filter((it) => (it.seat || 'Mesa') === seat);
    const sum = own.reduce((a, it) => a + it.price * it.qty, 0);
    return `<div class="seat-block">
      <div class="seat-name"><span class="n">${esc(seat.replace(/\D+/g, '') || '·')}</span>${esc(seat)}
        <span style="margin-left:auto">${money.format(sum)}</span></div>
      ${own.map((it) => lineHtml(it, tickets)).join('')}
    </div>`;
  }).join('');

  const ticketRows = tickets.length
    ? tickets.map((tk) => {
        const next = TICKET_NEXT[tk.status];
        return `<div class="line">
          <div class="body">
            <div class="name">Pedido ${tk.n} <span class="tstatus ${esc(tk.status)}">${esc(TICKET_LABELS[tk.status])}</span></div>
            <div class="note">${age(tk.sentAt)}</div>
          </div>
          ${next ? `<button class="btn small primary" data-adv="${esc(tk.id)}">${esc(TICKET_ADVANCE[tk.status])}</button>` : ''}
        </div>`;
      }).join('')
    : '<div class="empty">Nada enviado a cocina todavía.</div>';

  panel.innerHTML = `
    <h2>${esc(b.dock)}</h2>
    <div class="sub">${esc(st.label)} · agente: ${esc(b.agentState)} ${s.waiterCalled ? '· <b style="color:var(--err)">llamó al mesero</b>' : ''}</div>
    <div class="section-title">Pedido por comensal</div>
    ${seatBlocks || '<div class="empty">Sin productos.</div>'}
    <div class="line" style="border-top:2px dashed var(--line); font-weight:800">
      <div class="body"><div class="name">Total</div></div>
      <div class="price" style="color:var(--primary); font-size:15px">${money.format(s.total || 0)}</div>
    </div>
    <div class="section-title">Pedidos en cocina</div>
    ${ticketRows}
    <div class="actions">
      <a class="btn ghost" href="/?dock=${encodeURIComponent(b.dock)}" target="_blank">Ver pantalla de la mesa</a>
      <button class="btn danger" id="btnFree">Liberar mesa</button>
    </div>`;

  panel.querySelectorAll('[data-adv]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tk = tickets.find((t) => t.id === btn.dataset.adv);
      if (tk) advanceTicket(b.dock, tk.id, TICKET_NEXT[tk.status]);
    });
  });
  panel.querySelector('#btnFree').addEventListener('click', () => resetTable(b.dock));
}

function lineHtml(it, tickets) {
  const tk = tickets.find((t) => t.id === it.ticket);
  return `<div class="line">
    <div class="qty">${it.qty || 1}</div>
    <div class="body">
      <div class="name">${esc(it.label || it.sku)}</div>
      <div class="note">
        ${tk ? `<span class="tstatus ${esc(tk.status)}">${esc(TICKET_LABELS[tk.status])}</span>` : 'Por confirmar'}
        ${it.note ? ` · ${esc(it.note)}` : ''}
      </div>
    </div>
    <div class="price">${money.format((it.price || 0) * (it.qty || 1))}</div>
  </div>`;
}

// ------------------------------------------------------------------ cocina

function age(ts) {
  if (!ts) return '';
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return min < 1 ? 'hace un momento' : `hace ${min} min`;
}

function renderKitchen() {
  const all = [];
  for (const b of boards.values()) {
    for (const tk of b.state?.tickets || []) {
      all.push({ board: b, ticket: tk, items: (b.state.items || []).filter((it) => it.ticket === tk.id) });
    }
  }
  const open = all.filter((t) => t.ticket.status !== 'served').length;
  el('badgeCocina').hidden = !open;
  el('badgeCocina').textContent = String(open);

  el('kanban').innerHTML = KANBAN_COLS.map((col) => {
    const cards = all
      .filter((t) => t.ticket.status === col)
      .sort((a, b) => (a.ticket.sentAt || 0) - (b.ticket.sentAt || 0));
    return `<div class="kcol">
      <div class="kcol-head"><h3>${esc(TICKET_LABELS[col])}</h3><span class="count">${cards.length}</span></div>
      <div class="stack">
        ${cards.map(({ board, ticket, items }) => {
          const mins = ticket.sentAt ? (Date.now() - ticket.sentAt) / 60000 : 0;
          const next = TICKET_NEXT[ticket.status];
          return `<div class="card tk ${esc(ticket.status)}">
            <div class="head">
              <span class="mesa">${esc(board.dock)} · P${ticket.n}</span>
              <span class="age${mins > 20 && ticket.status !== 'served' ? ' late' : ''}">${age(ticket.sentAt)}</span>
            </div>
            <div class="lines">
              ${items.map((it) => `<div class="line">
                <div class="qty">${it.qty || 1}</div>
                <div class="body">
                  <div class="name">${esc(it.label || it.sku)}</div>
                  ${it.seat || it.note ? `<div class="note">${it.seat ? `<span class="who">${esc(it.seat)}</span>` : ''}${it.note ? `${it.seat ? ' · ' : ''}${esc(it.note)}` : ''}</div>` : ''}
                </div>
              </div>`).join('') || '<div class="empty">—</div>'}
            </div>
            ${next ? `<button class="btn primary advance" data-dock="${esc(board.dock)}" data-tk="${esc(ticket.id)}" data-next="${esc(next)}">${esc(TICKET_ADVANCE[ticket.status])}</button>` : ''}
          </div>`;
        }).join('') || '<div class="empty">—</div>'}
      </div>
    </div>`;
  }).join('');

  el('kanban').querySelectorAll('.advance').forEach((btn) => {
    btn.addEventListener('click', () =>
      advanceTicket(btn.dataset.dock, btn.dataset.tk, btn.dataset.next));
  });
}

// ------------------------------------------------------------------- carta

let menuDraft = null;
let menuDirty = false;

function setDirty(d) {
  menuDirty = d;
  el('dirtyNote').hidden = !d;
}

function acceptMenu(menu) {
  if (!menu) return;
  if (menuDirty) return; // never clobber edits in progress
  menuDraft = JSON.parse(JSON.stringify(menu));
  if (menu.restaurant) el('place').textContent = menu.restaurant;
  renderMenuEditor();
}

async function loadMenu() {
  try {
    const res = await fetch('/api/menu');
    const { menu } = await res.json();
    acceptMenu(menu);
  } catch {
    el('menuEditor').innerHTML = '<div class="empty">No se pudo cargar la carta.</div>';
  }
}

function slug(label, taken) {
  let base = label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  let out = base, n = 2;
  while (taken.has(out)) out = `${base}-${n++}`;
  return out;
}

function allSkus() {
  const set = new Set();
  for (const c of menuDraft.categories) for (const i of c.items) set.add(i.sku);
  return set;
}

function renderMenuEditor() {
  if (!menuDraft) return;
  el('restName').value = menuDraft.restaurant || '';

  el('menuEditor').innerHTML = menuDraft.categories.map((cat, ci) => `
    <div class="card menu-cat" data-ci="${ci}">
      <div class="cat-head">
        <input class="field grow cat-label" value="${esc(cat.label)}" placeholder="Nombre de la categoría" />
        <span class="n">${cat.items.length} plato(s)</span>
        <button class="btn small danger del-cat">Eliminar</button>
      </div>
      ${cat.items.map((it, ii) => `
        <div class="menu-item" data-ii="${ii}">
          <span class="sku" title="${esc(it.sku)}">${esc(it.sku)}</span>
          <input class="field name it-label" value="${esc(it.label)}" placeholder="Plato" />
          <input class="field price it-price" type="number" min="0" step="500" value="${it.price}" />
          <input class="field desc it-desc" value="${esc(it.desc || '')}" placeholder="Descripción (opcional)" />
          <button class="btn small danger del-item">✕</button>
        </div>`).join('')}
      <div class="add-row">
        <input class="field grow new-label" placeholder="Nuevo plato…" />
        <input class="field price new-price" type="number" min="0" step="500" placeholder="Precio" />
        <button class="btn small primary add-item">Agregar</button>
      </div>
    </div>`).join('');

  // Text edits mutate the draft in place — no re-render, so focus survives.
  el('menuEditor').querySelectorAll('.menu-cat').forEach((catEl) => {
    const cat = menuDraft.categories[Number(catEl.dataset.ci)];

    catEl.querySelector('.cat-label').addEventListener('input', (e) => {
      cat.label = e.target.value;
      setDirty(true);
    });
    catEl.querySelector('.del-cat').addEventListener('click', () => {
      if (cat.items.length && !confirm(`Eliminar "${cat.label}" y sus ${cat.items.length} plato(s)?`)) return;
      menuDraft.categories = menuDraft.categories.filter((c) => c !== cat);
      setDirty(true);
      renderMenuEditor();
    });

    catEl.querySelectorAll('.menu-item').forEach((itEl) => {
      const it = cat.items[Number(itEl.dataset.ii)];
      itEl.querySelector('.it-label').addEventListener('input', (e) => { it.label = e.target.value; setDirty(true); });
      itEl.querySelector('.it-price').addEventListener('input', (e) => { it.price = Number(e.target.value) || 0; setDirty(true); });
      itEl.querySelector('.it-desc').addEventListener('input', (e) => { it.desc = e.target.value; setDirty(true); });
      itEl.querySelector('.del-item').addEventListener('click', () => {
        cat.items = cat.items.filter((x) => x !== it);
        setDirty(true);
        renderMenuEditor();
      });
    });

    const addItem = () => {
      const label = catEl.querySelector('.new-label').value.trim();
      const price = Number(catEl.querySelector('.new-price').value);
      if (!label) return toast('El plato necesita un nombre', true);
      if (!(price >= 0)) return toast('El plato necesita un precio', true);
      cat.items.push({ sku: slug(label, allSkus()), label, price, desc: '', tags: [] });
      setDirty(true);
      renderMenuEditor();
    };
    catEl.querySelector('.add-item').addEventListener('click', addItem);
    catEl.querySelector('.new-label').addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(); });
  });
}

async function saveMenu() {
  if (!menuDraft) return;
  menuDraft.restaurant = el('restName').value.trim() || menuDraft.restaurant;
  // Drop items that lost their name instead of failing validation on them.
  for (const c of menuDraft.categories) c.items = c.items.filter((i) => i.label.trim());
  try {
    const res = await fetch('/api/menu', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ menu: menuDraft }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setDirty(false);
    acceptMenu(body.menu);
    toast('Carta guardada. Las mesas nuevas ya la usan.');
  } catch (e) {
    toast(`No se pudo guardar: ${e.message}`, true);
  }
}

// ------------------------------------------------------------------ chrome

let toastTimer = null;
function toast(text, isErr = false) {
  const t = el('toast');
  t.textContent = text;
  t.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function selectView(view) {
  currentView = view;
  location.hash = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  render();
}

function updateBadges() {
  const mesas = boards.size;
  el('badgeMesas').hidden = !mesas;
  el('badgeMesas').textContent = String(mesas);
  let open = 0;
  for (const b of boards.values()) {
    open += (b.state?.tickets || []).filter((t) => t.status !== 'served').length;
  }
  el('badgeCocina').hidden = !open;
  el('badgeCocina').textContent = String(open);
}

function render() {
  updateBadges();
  if (currentView === 'mesas') renderTables();
  else if (currentView === 'cocina') renderKitchen();
  // carta re-renders only on menu events, never on table traffic — typing
  // in the editor must not be interrupted.
}

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => selectView(tab.dataset.view)));

el('tableGrid').addEventListener('click', (e) => {
  const card = e.target.closest('.table-card');
  if (!card) return;
  selectedDock = selectedDock === card.dataset.dock ? null : card.dataset.dock;
  renderTables();
});

el('btnSaveMenu').addEventListener('click', saveMenu);
el('btnReloadMenu').addEventListener('click', () => { setDirty(false); loadMenu(); });
el('restName').addEventListener('input', () => setDirty(true));
el('btnAddCat').addEventListener('click', () => {
  if (!menuDraft) return;
  const label = prompt('Nombre de la nueva categoría:');
  if (!label?.trim()) return;
  const ids = new Set(menuDraft.categories.map((c) => c.id));
  menuDraft.categories.push({ id: slug(label, ids), label: label.trim(), items: [] });
  setDirty(true);
  renderMenuEditor();
});

selectView(currentView);
loadMenu();
discover();
setInterval(discover, 4000);
setInterval(() => { if (currentView === 'cocina') renderKitchen(); }, 30000);
