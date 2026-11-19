import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookSignatureError } from "./errors.js";

const TOLERANCIA_SEGUNDOS = 300; // 5 minutos, como pide la guía de webhooks

function header(headers, name) {
  if (typeof headers.get === "function") return headers.get(name) ?? undefined; // Headers de fetch
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** Firma "{id}.{timestamp}.{cuerpo}" (útil en tests). Devuelve "v1,<base64>". */
export function signWebhook(secret, id, timestamp, payload) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const body = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/**
 * Verifica la firma de un webhook y devuelve el evento parseado.
 * `payload` es el cuerpo CRUDO tal como llegó (antes de parsear el JSON).
 * Lanza WebhookSignatureError si falta un header, la firma no coincide o el timestamp es muy antiguo.
 */
export function verifyWebhook(payload, headers, secret, { tolerance = TOLERANCIA_SEGUNDOS, now = Date.now() / 1000 } = {}) {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatures) {
    throw new WebhookSignatureError(
      "Faltan headers del webhook (webhook-id, webhook-timestamp o webhook-signature).",
      { code: "WEBHOOK_HEADERS_MISSING" },
    );
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new WebhookSignatureError("El timestamp del webhook no es válido.", { code: "WEBHOOK_TIMESTAMP_INVALID" });
  }
  if (Math.abs(now - ts) > tolerance) {
    throw new WebhookSignatureError(
      "El timestamp del webhook está fuera de la ventana permitida (posible reenvío).",
      { code: "WEBHOOK_TIMESTAMP_EXPIRED" },
    );
  }
  const esperada = Buffer.from(signWebhook(secret, id, timestamp, payload));
  // El header puede traer varias firmas separadas por espacio (rotación de secreto).
  for (const candidata of signatures.split(" ")) {
    const c = Buffer.from(candidata.trim());
    if (c.length === esperada.length && timingSafeEqual(c, esperada)) {
      return JSON.parse(typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"));
    }
  }
  throw new WebhookSignatureError("La firma del webhook no coincide.", { code: "WEBHOOK_SIGNATURE_INVALID" });
}
