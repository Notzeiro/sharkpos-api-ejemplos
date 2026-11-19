import { randomUUID } from "node:crypto";
import { ConnectionFailedError, SharkposError, errorForStatus } from "./errors.js";

export const PRODUCTION_URL = "https://api.sharkpos.cl";
export const SANDBOX_URL = "https://sandbox.sharkpos.cl";
export const VERSION = "0.1.0";

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_WAIT = 60; // segundos

const defaultSleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, String(v)));
    else search.append(key, String(value));
  }
  const q = search.toString();
  return q ? `?${q}` : "";
}

/**
 * Cliente de SharkPOS API. Una instancia sirve para un RUT (una API key).
 * Usa fetch nativo (Node 18+), sin dependencias.
 */
export class SharkposClient {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] por defecto SHARKPOS_API_KEY
   * @param {boolean} [options.sandbox] usa https://sandbox.sharkpos.cl (no transmite al SII)
   * @param {string} [options.baseUrl] sobreescribe la URL base (o SHARKPOS_BASE_URL)
   * @param {number} [options.timeout] segundos por intento (30)
   * @param {number} [options.maxRetries] reintentos ante 429, 5xx o falla de red (3)
   * @param {number} [options.backoff] espera base en segundos (0.5); el intento n espera backoff * 2^n
   * @param {(seconds: number) => Promise<void>} [options.sleep] inyectable para tests
   * @param {typeof fetch} [options.fetch] inyectable para tests
   */
  constructor(options = {}) {
    const apiKey = options.apiKey ?? process.env.SHARKPOS_API_KEY;
    if (!apiKey) {
      throw new SharkposError("Falta la API key. Pásala al crear el cliente o define SHARKPOS_API_KEY.", {
        code: "API_KEY_MISSING",
        solution: "Pide una llave de prueba gratis en https://api.sharkpos.cl/sandbox/",
      });
    }
    const url = options.baseUrl ?? process.env.SHARKPOS_BASE_URL ?? (options.sandbox ? SANDBOX_URL : PRODUCTION_URL);
    // La API key queda en un campo no enumerable: no sale en console.log ni en JSON.stringify.
    Object.defineProperty(this, "_apiKey", { value: apiKey, enumerable: false });
    this.baseUrl = url.replace(/\/+$/, "");
    this.timeout = options.timeout ?? 30;
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.backoff = options.backoff ?? 0.5;
    this._sleep = options.sleep ?? defaultSleep;
    this._fetch = options.fetch ?? globalThis.fetch;
  }

  _wait(attempt, retryAfter) {
    if (retryAfter !== undefined) return Math.min(Math.max(retryAfter, 0), MAX_WAIT);
    const base = this.backoff * 2 ** attempt;
    return Math.min(base + Math.random() * (base / 4), MAX_WAIT);
  }

  /**
   * Solicitud con reintentos; devuelve { status, headers, buffer }.
   * Un POST solo se reintenta ante 5xx o falla de red si lleva Idempotency-Key (o retryUnsafe: true para
   * consultas que no cambian nada). El 429 siempre se reintenta: la API no procesó la solicitud.
   */
  async requestRaw(method, path, { params, body, idempotencyKey, retryUnsafe = false } = {}) {
    const url = this.baseUrl + path + buildQuery(params);
    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      Accept: "application/json",
      "User-Agent": `sharkpos-node/${VERSION}`,
    };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    method = method.toUpperCase();
    const safe = method === "GET" || method === "HEAD" || Boolean(idempotencyKey) || retryUnsafe;

    for (let attempt = 0; ; attempt++) {
      let retryAfter;
      try {
        const res = await this._fetch(url, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.timeout * 1000),
        });
        const buffer = Buffer.from(await res.arrayBuffer());
        if (res.ok) return { status: res.status, headers: res.headers, buffer };
        const ra = res.headers.get("retry-after");
        retryAfter = ra !== null && ra !== "" && Number.isFinite(Number(ra)) ? Number(ra) : undefined;
        const retriable = RETRY_STATUS.has(res.status) && (res.status === 429 || safe);
        if (!retriable || attempt >= this.maxRetries) {
          let parsed = {};
          try { parsed = buffer.length ? JSON.parse(buffer.toString("utf8")) : {}; } catch { /* cuerpo no JSON */ }
          throw errorForStatus(res.status, parsed, retryAfter);
        }
      } catch (err) {
        if (err instanceof SharkposError) throw err;
        if (!safe || attempt >= this.maxRetries) {
          throw new ConnectionFailedError(`No se pudo conectar con SharkPOS API (${err?.cause?.code ?? err?.message ?? err}).`, {
            code: "CONNECTION_FAILED",
            solution: "Revisa tu conexión y reintenta con la misma Idempotency-Key.",
            cause: err,
          });
        }
      }
      await this._sleep(this._wait(attempt, retryAfter));
    }
  }

  /** Solicitud genérica que devuelve el JSON. Sirve para endpoints sin método propio. */
  async request(method, path, options = {}) {
    const res = await this.requestRaw(method, path, options);
    if (!res.buffer.length) return {};
    try {
      return JSON.parse(res.buffer.toString("utf8"));
    } catch {
      throw new SharkposError("La respuesta de la API no es JSON válido.", { code: "INVALID_RESPONSE", status: res.status });
    }
  }

  _emit(path, body, idempotencyKey) {
    // Una sola clave por llamada: todos los reintentos internos la reutilizan.
    return this.request("POST", path, { body, idempotencyKey: idempotencyKey ?? randomUUID() });
  }

  // ---------------------------------------------------------------- Emisión
  // Cada método acepta `idempotencyKey`. Usa el id de tu venta para que un reintento tuyo (no solo del
  // SDK) nunca emita dos documentos. Sin ella, el SDK genera un UUID4 y lo reutiliza en los reintentos.
  // Con una API key de producción estos métodos EMITEN un documento tributario real.

  emitBoleta(body, idempotencyKey) { return this._emit("/api/v1/dte/boleta/emit/", body, idempotencyKey); }
  emitFactura(body, idempotencyKey) { return this._emit("/api/v1/dte/factura/emit/", body, idempotencyKey); }
  emitFacturaExenta(body, idempotencyKey) { return this._emit("/api/v1/dte/factura-exenta/emit/", body, idempotencyKey); }
  emitNotaCredito(body, idempotencyKey) { return this._emit("/api/v1/dte/nota-credito/emit/", body, idempotencyKey); }
  emitNotaDebito(body, idempotencyKey) { return this._emit("/api/v1/dte/nota-debito/emit/", body, idempotencyKey); }
  emitFacturaCompra(body, idempotencyKey) { return this._emit("/api/v1/dte/factura-compra/emit/", body, idempotencyKey); }
  emitLiquidacionFactura(body, idempotencyKey) { return this._emit("/api/v1/dte/liquidacion-factura/emit/", body, idempotencyKey); }
  emitExportacion(body, idempotencyKey) { return this._emit("/api/v1/dte/exportacion/emit/", body, idempotencyKey); }
  emitNotaDebitoExportacion(body, idempotencyKey) { return this._emit("/api/v1/dte/nota-debito-exportacion/emit/", body, idempotencyKey); }
  emitNotaCreditoExportacion(body, idempotencyKey) { return this._emit("/api/v1/dte/nota-credito-exportacion/emit/", body, idempotencyKey); }
  emitGuiaDespacho(body, idempotencyKey) { return this._emit("/api/v1/dte/guia-despacho/emit/", body, idempotencyKey); }

  /** Anula una guía de despacho (Res. Ex. SII 144). Repetir la llamada devuelve la misma anulación. */
  voidGuiaDespacho(dteId, reason) {
    return this.request("POST", `/api/v1/dte/guia-despacho/${dteId}/void/`, { body: { reason }, retryUnsafe: true });
  }

  // -------------------------------------------------------------- Documentos

  getDocument(dteId) { return this.request("GET", `/api/v1/dte/documents/${dteId}/`); }
  getBoletaStatus(dteId) { return this.request("GET", `/api/v1/dte/boleta/${dteId}/status/`); }
  getDocumentTed(dteId) { return this.request("GET", `/api/v1/dte/documents/${dteId}/ted/`); }

  /** DTE firmado en XML (Buffer ISO-8859-1). */
  async getDocumentXml(dteId) { return (await this.requestRaw("GET", `/api/v1/dte/documents/${dteId}/xml/`)).buffer; }
  /** PDF417 del timbre como PNG (Buffer). */
  async getDocumentTedPng(dteId) { return (await this.requestRaw("GET", `/api/v1/dte/documents/${dteId}/ted.png`)).buffer; }
  /** PDF térmico de una boleta (paperWidth 58 u 80 mm). */
  async getBoletaPdf(dteId, paperWidth = 80) {
    return (await this.requestRaw("GET", `/api/v1/dte/boleta/${dteId}/pdf/`, { params: { paper_width: paperWidth } })).buffer;
  }
  /** PDF carta de factura, nota, factura de compra o guía de despacho. */
  async getB2bPdf(dteId) { return (await this.requestRaw("GET", `/api/v1/dte/b2b/${dteId}/pdf/`)).buffer; }

  /**
   * Una página del listado. Filtros: period, from, to, document_type, status, branch_id, folio_from,
   * folio_to, updated_after, limit (1-500), cursor.
   */
  listDocuments(filters = {}) { return this.request("GET", "/api/v1/dte/documents/", { params: filters }); }

  /** Recorre TODOS los documentos que cumplen los filtros, página por página (cursor). */
  async *iterDocuments(filters = {}) {
    const params = { ...filters };
    for (;;) {
      const page = await this.listDocuments(params);
      for (const doc of page.documents ?? []) yield doc;
      if (!page.has_more || !page.next_cursor) return;
      params.cursor = page.next_cursor;
    }
  }

  summarizeDocuments(filters = {}) { return this.request("GET", "/api/v1/dte/documents/summary/", { params: filters }); }

  /** ZIP (Buffer) con los XML firmados del período (custodia legal, máx. 92 días). */
  async exportDocuments({ desde, hasta, tipo, branch_id } = {}) {
    return (await this.requestRaw("GET", "/api/v1/dte/documents/export/", { params: { desde, hasta, tipo, branch_id } })).buffer;
  }

  // -------------------------------------------- Verificar ante el SII y folios

  /** Pregunta al SII por un documento (propio o de un tercero). No sirve para boletas. */
  verifyDocument(fields) { return this.request("POST", "/api/v1/dte/verify/", { body: fields, retryUnsafe: true }); }
  /** Estado de cesión (factoring) de una factura 33 o 34. */
  verifyCesion({ document_type, folio, issuer_rut }) {
    return this.request("POST", "/api/v1/dte/verify/cesion/", { body: { document_type, folio, issuer_rut }, retryUnsafe: true });
  }
  /** Pide anular en el SII un rango de folios propios que no se usarán (responde 202). */
  annulFolios({ document_type, folio_start, folio_end, reason }, idempotencyKey) {
    return this._emit("/api/v1/dte/folios/annul/", { document_type, folio_start, folio_end, reason }, idempotencyKey);
  }
  listFolioAnnulments(filters = {}) { return this.request("GET", "/api/v1/dte/folios/annul/", { params: filters }); }
  getFolioAnnulment(id) { return this.request("GET", `/api/v1/dte/folios/annul/${id}/`); }

  // ------------------------------------------------- RCV y bandeja de recibidos

  getRcvSummary({ period, operation, state }) { return this.request("GET", "/api/v1/dte/rcv/summary/", { params: { period, operation, state } }); }
  getVatEstimate({ period, carryover, ppm_rate, common_use_factor }) {
    return this.request("GET", "/api/v1/dte/rcv/vat-estimate/", { params: { period, carryover, ppm_rate, common_use_factor } });
  }
  listRcvDocuments({ period, operation, document_type }) {
    return this.request("GET", "/api/v1/dte/rcv/documents/", { params: { period, operation, document_type } });
  }
  listInbox(filters = {}) { return this.request("GET", "/api/v1/dte/inbox/", { params: filters }); }
  /** Acepta facturas recibidas ante el SII. Cada una: { supplier_rut, document_type, folio }. */
  acceptInvoices(documents) { return this.request("POST", "/api/v1/dte/inbox/actions/", { body: { action: "accept", documents } }); }
  /** Reclama facturas recibidas. claimReason: "RCD", "RFP" o "RFT". */
  claimInvoices(documents, claimReason) {
    return this.request("POST", "/api/v1/dte/inbox/actions/", { body: { action: "claim", claim_reason: claimReason, documents } });
  }

  // ---------------------------------------------------------------- Webhooks

  listWebhooks() { return this.request("GET", "/api/v1/dte/webhooks/"); }
  listWebhookEventTypes() { return this.request("GET", "/api/v1/dte/webhooks/event-types/"); }
  /** Registra un endpoint. La respuesta trae webhook.secret UNA sola vez: guárdalo. */
  createWebhook({ url, event_types, description }) { return this.request("POST", "/api/v1/dte/webhooks/", { body: { url, event_types, description } }); }
  getWebhook(id) { return this.request("GET", `/api/v1/dte/webhooks/${id}/`); }
  updateWebhook(id, fields) { return this.request("PATCH", `/api/v1/dte/webhooks/${id}/`, { body: fields }); }
  deleteWebhook(id) { return this.request("DELETE", `/api/v1/dte/webhooks/${id}/`); }
  rotateWebhookSecret(id) { return this.request("POST", `/api/v1/dte/webhooks/${id}/rotate-secret/`); }
  testWebhook(id) { return this.request("POST", `/api/v1/dte/webhooks/${id}/test/`); }
  listWebhookDeliveries(id, filters = {}) { return this.request("GET", `/api/v1/dte/webhooks/${id}/deliveries/`, { params: filters }); }
  retryWebhookDelivery(id, deliveryId) { return this.request("POST", `/api/v1/dte/webhooks/${id}/deliveries/${deliveryId}/retry/`); }
  recoverWebhook(id, since) { return this.request("POST", `/api/v1/dte/webhooks/${id}/recover/`, { body: { since } }); }
}
