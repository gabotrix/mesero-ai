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
    headers: {
      'content-type': 'application/json',
      apikey: config.supabase.anonKey,
      authorization: `Bearer ${config.supabase.anonKey}`,
    },
    body: JSON.stringify(body),
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
export async function sendPaymentLink({ phone, paymentUrl, reference, amount }) {
  if (!ENABLED) return { sent: false, reason: 'WHATSAPP_SEND=0' };
  if (normalizePhone(phone).length < 12) return { sent: false, reason: 'teléfono inválido' };
  if (!paymentUrl) return { sent: false, reason: 'sin enlace de pago' };

  const data = await callBridge({
    action: 'send_payment_link',
    phone,
    paymentUrl,
    reference,
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
export async function sendReceipt({ phone, transactionId, amount, items }) {
  if (!ENABLED) return { sent: false, reason: 'WHATSAPP_SEND=0' };
  if (!RESTAURANT_RECEIPT_TEMPLATE) {
    return {
      sent: false,
      reason:
        'falta una plantilla de comprobante aprobada para el restaurante ' +
        '(defínela en WHATSAPP_RECEIPT_TEMPLATE)',
    };
  }
  const dishes = (items || [])
    .map((it) => `${it.qty || 1} ${it.label || it.sku}`)
    .join(', ')
    .slice(0, 300);

  const data = await callBridge({
    action: 'send_receipt',
    phone,
    receiptType: RESTAURANT_RECEIPT_TEMPLATE,
    transactionId,
    details: { total: amount, items: dishes },
  });
  return { sent: true, messageId: data.messageId };
}
