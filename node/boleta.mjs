// Ejemplo de SharkPOS API (sandbox). Guía: https://api.sharkpos.cl/guias/boleta-electronica-node/
// Variable de entorno: SHARKPOS_API_KEY. Nunca pongas la API key en el código.

const BASE = "https://sandbox.sharkpos.cl/api/v1/dte";
const API_KEY = process.env.SHARKPOS_API_KEY;

const boleta = {
  document_type: 39,
  amount_total: 16980,
  medio_pago: 1,
  items: [
    { name: "Ñoquis a la boloñesa", qty: 1, price: 8990 },
    { name: "Café cortado", qty: 2, price: 3995 },
  ],
};

const res = await fetch(`${BASE}/boleta/emit/`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "venta-884", // estable por venta
  },
  body: JSON.stringify(boleta),
  signal: AbortSignal.timeout(30000),
});

console.log(res.status, await res.json());


const dormir = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function emitirBoleta(ventaId, body, intentos = 5) {
  let espera = 2;
  for (let i = 0; i < intentos; i++) {
    let res;
    try {
      res = await fetch(`${BASE}/boleta/emit/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": ventaId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      await dormir(espera); espera *= 2; continue; // error de red
    }

    if (res.status === 200 || res.status === 201) return res.json();
    if (res.status === 202 || res.status >= 500) {
      await dormir(espera); espera *= 2; continue;
    }
    if (res.status === 429) {
      await dormir(Number(res.headers.get("Retry-After")) || espera); continue;
    }

    const err = await res.json(); // otro 4xx: no reintentar
    throw new Error(`${err.code}: ${err.message} ${err.solution ?? ""}`);
  }
  throw new Error("Sin respuesta definitiva; reintenta con la misma Idempotency-Key");
}


async function esperarResultado(dteId, maximo = 8) {
  let espera = 30, doc;
  for (let i = 0; i < maximo; i++) {
    const res = await fetch(`${BASE}/documents/${dteId}/`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    doc = await res.json();
    if (doc.is_final) return doc;
    await dormir(espera);
    espera = Math.min(espera * 2, 300);
  }
  return doc;
}

const emitida = await emitirBoleta("venta-884", boleta);
const doc = await esperarResultado(emitida.dte_id);
console.log(doc.public_status, doc.message);
