import { config } from './config.js';

/**
 * WhatsApp delivery, through the Infobip bridge already deployed in Supabase.
 *
 * The diner leaves a phone number on the payment step and expects two things by
 * WhatsApp: the link to pay, and the receipt afterwards. Only the first of those
 * can be sent today, and the reason is worth writing down because it is not a
 * bug anyone can fix in this repo.
 *
 * WhatsApp will not carry a business-initiated message unless it matches a
 * template that Meta has already approved for that specific business account.
 * Free-form replies are allowed only inside a 24-hour window that opens when the
 * *customer* writes first — and a diner reading a QR code never writes first. So
 * every message this file sends has to be a template that exists upstream.
 *
 * The bridge this talks to has a payment-link template approved already — a
 * reference, an amount and a button — so that message sends today. It has no
 * template for a receipt, and one cannot be improvised: the text of every
 * business-initiated message is approved in advance, per business.
 *
 * `WHATSAPP_RECEIPT_TEMPLATE` is that missing piece. A restaurant gets a receipt
 * template approved under its own WhatsApp Business account, names it there, and
 * sendReceipt stops being a no-op.
 */

const RESTAURANT_RECEIPT_TEMPLATE = process.env.WHATSAPP_RECEIPT_TEMPLATE || '';

/** Sending is opt-out rather than opt-in: a real number costs a real message. */
const ENABLED = process.env.WHATSAPP_SEND !== '0';

function fnUrl(name) {
  return `https://${config.supabase.projectRef}.supabase.co/functions/v1/${name}`;
}

async function callBridge(body) {
  const res = await fetch(fnUrl('infobip-whatsapp'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Every one of these functions authenticates the caller by its venue key.
    // Leaving it out is how a restaurant that could take orders all evening
    // discovered at the till that it could not charge anybody.
    body: JSON.stringify({ ...body, venueKey: config.venueKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(String(data.error || res.status));
  return data;
}

/** Colombian mobiles are ten digits; Infobip wants them with the country code. */
export function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('57') && digits.length >= 12) return digits;
  if (digits.length === 10) return `57${digits}`;
  return digits;
}

/**
 * @param {{phone:string, paymentUrl:string, reference:string, amount:number}} bill
 * @returns {Promise<{sent:boolean, messageId?:string, reason?:string}>}
 */
export async function sendPaymentLink({ phone, paymentUrl, reference, amount, brand }) {
  if (!ENABLED) return { sent: false, reason: 'WHATSAPP_SEND=0' };
  if (normalizePhone(phone).length < 12) return { sent: false, reason: 'teléfono inválido' };
  if (!paymentUrl) return { sent: false, reason: 'sin enlace de pago' };

  const data = await callBridge({
    action: 'send_payment_link',
    phone,
    paymentUrl,
    reference,
    // The restaurant's own name, which selects the restaurant template. Without
    // it the bridge keeps its original behaviour and a diner at a parrilla gets
    // a message headed with the name of a lottery company.
    brand,
    details: { amount },
  });
  return { sent: true, messageId: data.messageId };
}

/**
 * The receipt, once the restaurant has a template of its own.
 *
 * Deliberately a no-op rather than a throw: a table that has already paid must
 * not see an error because a marketing approval is pending somewhere.
 */
export async function sendReceipt({ phone, transactionId, amount, items, brand, table }) {
  if (!ENABLED) return { sent: false, reason: 'WHATSAPP_SEND=0' };
  if (normalizePhone(phone).length < 12) return { sent: false, reason: 'teléfono inválido' };

  const dishes = (items || [])
    .map((it) => `${it.qty || 1} ${it.label || it.sku}`)
    .join(', ')
    .slice(0, 300);

  const data = await callBridge({
    action: 'send_receipt',
    phone,
    // One template serves every restaurant: the name is a placeholder, not part
    // of the approved text. RESTAURANT_RECEIPT_TEMPLATE stays honoured for a
    // restaurant that got its own approved under its own business account.
    receiptType: RESTAURANT_RECEIPT_TEMPLATE || 'mesero',
    transactionId,
    details: { total: amount, items: dishes, brand, table },
  });
  return { sent: true, messageId: data.messageId };
}
