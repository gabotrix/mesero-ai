import { config } from './config.js';

/**
 * Payment links, through the Wompi bridge already deployed in Supabase.
 *
 * The merchant keys live in Supabase secrets, so neither this backend nor the
 * table screen ever holds one — the same reason the voice model is reached
 * through a bridge rather than directly.
 *
 * Sandbox versus production is not a setting here: the bridge picks it from the
 * key it was given, and a link built from a test key comes back with a `test_`
 * id. That means there is no switch anyone can forget to flip before a shift.
 */
function fnUrl(name) {
  return `https://${config.supabase.projectRef}.supabase.co/functions/v1/${name}`;
}

async function callFunction(name, body) {
  const res = await fetch(fnUrl(name), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: config.supabase.anonKey,
      authorization: `Bearer ${config.supabase.anonKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const detail =
      data?.details?.error?.reason || data?.details?.error?.type || data?.error || res.status;
    throw new Error(String(detail));
  }
  return data;
}

/**
 * @param {{amount:number, reference:string, description:string}} bill
 * @returns {Promise<{linkId:string, paymentUrl:string, sandbox:boolean}>}
 */
export async function createPaymentLink({ amount, reference, description }) {
  // Wompi rejects anything under 1500 COP outright. Saying so here beats
  // surfacing "UNPROCESSABLE" to somebody holding a phone at a table.
  if (!Number.isFinite(amount) || amount < 1500) {
    throw new Error('El total debe ser al menos $1.500 para generar un enlace de pago');
  }

  const data = await callFunction('wompi-payment', {
    action: 'create_link',
    amount,
    reference,
    description,
  });

  return {
    linkId: data.linkId,
    paymentUrl: data.paymentUrl,
    sandbox: String(data.linkId || '').startsWith('test_'),
  };
}

/** Asks the bridge whether anybody has actually paid that link yet. */
export async function checkPayment(linkId) {
  const data = await callFunction('wompi-payment', { action: 'check_status', linkId });
  return {
    status: data.status || 'PENDING',
    transactionId: data.transactionId || null,
    paid: data.status === 'APPROVED',
    raw: data,
  };
}
