/**
 * The table screen, in the diner's language.
 *
 * Chosen from their own phone. This screen belongs to the person holding it,
 * not to the restaurant: a Chinese visitor at a Colombian table should read
 * Chinese even though the agent greets in Spanish, and nothing is lost by that
 * — the dish names never translate in either direction anyway.
 *
 * Where the phone's language is one we do not have, we fall back to the
 * language the agent greets in rather than to Spanish, so the screen and the
 * voice at least agree.
 *
 * No build step, no dependency: this file is loaded by index.html and applied
 * once at boot, then again if somebody picks a different language by hand.
 */

const DICT = {
  es: {
    'title.welcome': '¡Bienvenido!',
    'welcome.sub': 'Habla con nuestro mesero. No tienes que tocar nada.',
    'state.listening': 'Te estoy escuchando',
    'assistant.hint': 'Cuéntame qué quieres ordenar o pregúntame por la carta.',
    'suggest.recommend': '¿Qué me recomiendas?',
    'suggest.recommend.say': '¿Qué me recomiendas hoy?',
    'suggest.menu': 'Ver la carta',
    'suggest.menu.say': 'Muéstrame la carta, por favor.',
    'back': '← Volver',
    'kicker.explore': 'Explora',
    'view.menu': 'Nuestra carta',
    'kicker.live': 'En tiempo real',
    'view.order': 'Tu pedido',
    'total': 'Total',
    'total.tax': 'IVA incluido',
    'kicker.last': 'Último paso',
    'view.pay': 'Pagar la cuenta',
    'pay.total': 'Total de la mesa',
    'pay.phoneAsk': '¿A qué número te enviamos el comprobante?',
    'pay.phoneHint': 'Usaremos este número también para enviarte la factura por WhatsApp.',
    'pay.cta': 'Generar enlace de pago',
    'pay.working': 'Generando el enlace…',
    'pay.go': 'Ir a pagar',
    'pay.sandbox': 'Modo de pruebas · no se cobra dinero real',
    'summary.title': '¡Gracias por visitarnos!',
    'summary.text': 'Tu pago fue recibido.',
    'btn.waiter': 'Pedir mesero',
    'btn.waiterOnWay': 'Mesero en camino',
    'btn.menu': 'La carta',
    'btn.bill': 'La cuenta',
    'table': 'Mesa',
    'connected': 'Asistente activo',
    'menu.loading': 'La carta se está cargando.',
    'pay.phonePh': '300 123 4567',
    'ticket.kitchen': 'Enviado a cocina',
    'ticket.preparing': 'En preparación',
    'ticket.ready': 'Listo para servir',
    'ticket.served': 'Servido',
    'ticket.received': 'Pedido recibido',
    'state.offline.title': 'Mesa desconectada',
    'state.offline.hint': 'Avisa al personal. La pantalla se reconecta sola.',
    'state.idle.title': 'Mesero en pausa',
    'state.idle.hint': 'Enciéndelo con el botón, o solo di «mesero».',
    'state.listening.title': 'Te estoy escuchando',
    'state.listening.hint': 'Cuéntame qué quieres ordenar o pregúntame por la carta.',
    'state.thinking.title': 'Un momento',
    'state.thinking.hint': 'Estoy preparando tu respuesta.',
    'state.talking.title': 'El mesero responde',
    'state.talking.hint': 'Puedes interrumpirlo cuando quieras.',
    'order.empty': 'Aún no has pedido nada.',
    'order.empty.hint': 'Solo díselo al mesero en voz alta.',
    'pay.ctaWithPhone': 'Comprobante a este número',
    'pay.working.short': 'Generando…',
    'pay.retry': 'Reintentar',
    'toast.paid': 'Pago recibido. ¡Gracias!',
    'toast.waiter': 'Listo, un mesero se acercará a tu mesa.',
    'lang.label': 'Idioma',
  },
  en: {
    'title.welcome': 'Welcome!',
    'welcome.sub': 'Just talk to our waiter. You do not have to touch anything.',
    'state.listening': "I'm listening",
    'assistant.hint': 'Tell me what you would like, or ask me about the menu.',
    'suggest.recommend': 'What do you recommend?',
    'suggest.recommend.say': 'What do you recommend today?',
    'suggest.menu': 'Show the menu',
    'suggest.menu.say': 'Show me the menu, please.',
    'back': '← Back',
    'kicker.explore': 'Browse',
    'view.menu': 'Our menu',
    'kicker.live': 'Live',
    'view.order': 'Your order',
    'total': 'Total',
    'total.tax': 'Tax included',
    'kicker.last': 'Last step',
    'view.pay': 'Pay the bill',
    'pay.total': 'Table total',
    'pay.phoneAsk': 'Which number should we send the receipt to?',
    'pay.phoneHint': 'We will use this number to send your receipt over WhatsApp too.',
    'pay.cta': 'Create payment link',
    'pay.working': 'Creating the link…',
    'pay.go': 'Go and pay',
    'pay.sandbox': 'Test mode · no real money is charged',
    'summary.title': 'Thank you for coming!',
    'summary.text': 'Your payment went through.',
    'btn.waiter': 'Call a waiter',
    'btn.waiterOnWay': 'Waiter on the way',
    'btn.menu': 'Menu',
    'btn.bill': 'Bill',
    'table': 'Table',
    'connected': 'Assistant active',
    'menu.loading': 'The menu is loading.',
    'pay.phonePh': '300 123 4567',
    'ticket.kitchen': 'Sent to the kitchen',
    'ticket.preparing': 'Being prepared',
    'ticket.ready': 'Ready to serve',
    'ticket.served': 'Served',
    'ticket.received': 'Order received',
    'state.offline.title': 'Table disconnected',
    'state.offline.hint': 'Let the staff know. The screen reconnects on its own.',
    'state.idle.title': 'Waiter paused',
    'state.idle.hint': 'Wake it with the button, or just say "waiter".',
    'state.listening.title': "I'm listening",
    'state.listening.hint': 'Tell me what you would like, or ask me about the menu.',
    'state.thinking.title': 'One moment',
    'state.thinking.hint': 'Working on your answer.',
    'state.talking.title': 'The waiter is speaking',
    'state.talking.hint': 'You can interrupt any time.',
    'order.empty': 'You have not ordered anything yet.',
    'order.empty.hint': 'Just say it out loud to the waiter.',
    'pay.ctaWithPhone': 'Send the receipt to this number',
    'pay.working.short': 'Creating…',
    'pay.retry': 'Try again',
    'toast.paid': 'Payment received. Thank you!',
    'toast.waiter': 'Done — a waiter is on the way to your table.',
    'lang.label': 'Language',
  },
  zh: {
    'title.welcome': '欢迎光临！',
    'welcome.sub': '直接和我们的服务员说话，什么都不用点。',
    'state.listening': '我在听',
    'assistant.hint': '告诉我你想点什么，或者问我菜单上有什么。',
    'suggest.recommend': '有什么推荐？',
    'suggest.recommend.say': '今天有什么推荐？',
    'suggest.menu': '看看菜单',
    'suggest.menu.say': '请给我看看菜单。',
    'back': '← 返回',
    'kicker.explore': '浏览',
    'view.menu': '我们的菜单',
    'kicker.live': '实时',
    'view.order': '你的订单',
    'total': '合计',
    'total.tax': '含税',
    'kicker.last': '最后一步',
    'view.pay': '结账',
    'pay.total': '本桌合计',
    'pay.phoneAsk': '收据发送到哪个号码？',
    'pay.phoneHint': '我们也会用这个号码通过 WhatsApp 发送账单。',
    'pay.cta': '生成支付链接',
    'pay.working': '正在生成链接…',
    'pay.go': '去支付',
    'pay.sandbox': '测试模式 · 不会真实扣款',
    'summary.title': '谢谢光临！',
    'summary.text': '你的付款已收到。',
    'btn.waiter': '呼叫服务员',
    'btn.waiterOnWay': '服务员正在过来',
    'btn.menu': '菜单',
    'btn.bill': '账单',
    'table': '桌号',
    'connected': '助手已连接',
    'menu.loading': '菜单加载中。',
    'pay.phonePh': '300 123 4567',
    'ticket.kitchen': '已送到厨房',
    'ticket.preparing': '正在制作',
    'ticket.ready': '可以上菜',
    'ticket.served': '已上菜',
    'ticket.received': '订单已收到',
    'state.offline.title': '本桌已断开',
    'state.offline.hint': '请告知店员。屏幕会自动重新连接。',
    'state.idle.title': '服务员已暂停',
    'state.idle.hint': '按一下按钮唤醒，或者直接说「服务员」。',
    'state.listening.title': '我在听',
    'state.listening.hint': '告诉我你想点什么，或者问我菜单上有什么。',
    'state.thinking.title': '稍等一下',
    'state.thinking.hint': '正在为你准备回答。',
    'state.talking.title': '服务员正在回答',
    'state.talking.hint': '你随时可以打断。',
    'order.empty': '你还没有点任何东西。',
    'order.empty.hint': '直接开口告诉服务员就行。',
    'pay.ctaWithPhone': '把收据发到这个号码',
    'pay.working.short': '生成中…',
    'pay.retry': '重试',
    'toast.paid': '已收到付款，谢谢！',
    'toast.waiter': '好的，服务员马上过来。',
    'lang.label': '语言',
  },
};

export const LANGS = [
  { code: 'es', short: 'ES' },
  { code: 'en', short: 'EN' },
  { code: 'zh', short: '中' },
];

const STORAGE = 'mesero.diner.lang';
let current = 'es';

function normalise(tag) {
  const base = String(tag || '').toLowerCase().split('-')[0];
  return DICT[base] ? base : null;
}

/**
 * @param {string} [agentPrimary] the language the agent greets in, used only
 *   when the phone asks for something we cannot render.
 */
export function pickLang(agentPrimary) {
  try {
    const saved = normalise(localStorage.getItem(STORAGE));
    if (saved) return saved;
  } catch {
    // A phone in private mode throws here. Not worth failing the page over.
  }
  for (const tag of navigator.languages || [navigator.language]) {
    const hit = normalise(tag);
    if (hit) return hit;
  }
  return normalise(agentPrimary) || 'es';
}

export function setLang(code, { remember = true } = {}) {
  current = normalise(code) || 'es';
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : current;
  if (remember) {
    try {
      localStorage.setItem(STORAGE, current);
    } catch {
      // Remembering is a convenience, not a requirement.
    }
  }
  apply();
}

export function lang() {
  return current;
}

export function T(key) {
  return DICT[current]?.[key] ?? DICT.es[key] ?? key;
}

/** Rewrites every element carrying a data-i18n hook. Safe to call repeatedly. */
export function apply(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = T(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = T(el.dataset.i18nPh);
  });
  root.querySelectorAll('[data-i18n-say]').forEach((el) => {
    el.dataset.say = T(el.dataset.i18nSay);
  });
}
