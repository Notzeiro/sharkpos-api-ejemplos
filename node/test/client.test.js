// Pruebas contra un servidor HTTP simulado local. No toca la red real.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  SharkposClient, SharkposError, AuthenticationError, ConflictError, ConnectionFailedError,
  RateLimitError, ServerError, ValidationError, WebhookSignatureError, verifyWebhook, signWebhook,
} from "../src/index.js";

let server, url, requests, queue, sleeps, client;

function on(method, path, status, payload, headers = {}) {
  const k = `${method} ${path}`;
  (queue[k] ??= []).push({ status, payload, headers });
}

beforeEach(async () => {
  requests = []; queue = {}; sleeps = [];
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const items = queue[`${req.method} ${req.url.split("?")[0]}`] ?? [];
      const item = items.length > 1 ? items.shift() : items[0] ?? { status: 404, payload: { code: "NOT_FOUND", message: "x" }, headers: {} };
      if (item.payload === "HANGUP") return req.socket.destroy();
      const body = Buffer.isBuffer(item.payload) ? item.payload : Buffer.from(JSON.stringify(item.payload));
      res.writeHead(item.status, { "Content-Length": body.length, ...item.headers });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
  client = new SharkposClient({ apiKey: "test-key", baseUrl: url, backoff: 1, sleep: async (s) => { sleeps.push(s); } });
});

afterEach(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

test("exige API key", () => {
  delete process.env.SHARKPOS_API_KEY;
  assert.throws(() => new SharkposClient({ baseUrl: url }), (e) => e instanceof SharkposError && e.code === "API_KEY_MISSING");
});

test("la API key no se filtra al imprimir el cliente", () => {
  assert.ok(!JSON.stringify(client).includes("test-key"));
});

test("emisión: Bearer y Idempotency-Key UUID4 automática", async () => {
  on("POST", "/api/v1/dte/boleta/emit/", 201, { status: "success", folio: 7 });
  const out = await client.emitBoleta({ amount_total: 100, items: [{ name: "Ñandú", price: 100 }] });
  assert.equal(out.folio, 7);
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
  assert.match(requests[0].headers["idempotency-key"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  assert.equal(requests[0].body.items[0].name, "Ñandú");
});

test("reintenta 5xx con la misma clave y backoff exponencial", async () => {
  const p = "/api/v1/dte/factura/emit/";
  on("POST", p, 503, { code: "SII_UNAVAILABLE", message: "caído" });
  on("POST", p, 503, { code: "SII_UNAVAILABLE", message: "caído" });
  on("POST", p, 201, { status: "success", folio: 1 });
  const out = await client.emitFactura({ x: 1 }, "venta-884");
  assert.equal(out.folio, 1);
  assert.equal(requests.length, 3);
  assert.deepEqual(new Set(requests.map((r) => r.headers["idempotency-key"])), new Set(["venta-884"]));
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] >= sleeps[0]);
});

test("respeta Retry-After en 429", async () => {
  const p = "/api/v1/dte/boleta/emit/";
  on("POST", p, 429, { code: "RATE_LIMIT_EXCEEDED", message: "lento" }, { "Retry-After": "7" });
  on("POST", p, 201, { status: "success" });
  await client.emitBoleta({});
  assert.deepEqual(sleeps, [7]);
});

test("se rinde tras maxRetries", async () => {
  on("POST", "/api/v1/dte/boleta/emit/", 500, { code: "INTERNAL_ERROR", message: "falla" });
  await assert.rejects(client.emitBoleta({}), ServerError);
  assert.equal(requests.length, 4);
});

test("429 expone retryAfter", async () => {
  const c = new SharkposClient({ apiKey: "k", baseUrl: url, maxRetries: 0 });
  on("GET", "/api/v1/dte/documents/x/", 429, { code: "RATE_LIMIT_EXCEEDED", message: "m" }, { "Retry-After": "3" });
  await assert.rejects(c.getDocument("x"), (e) => e instanceof RateLimitError && e.retryAfter === 3);
});

test("4xx no se reintenta y trae code, message, solution", async () => {
  on("POST", "/api/v1/dte/boleta/emit/", 400, { code: "INVALID_REQUEST", message: "Monto inválido", solution: "Revisa amount_total" });
  await assert.rejects(client.emitBoleta({}), (e) =>
    e instanceof ValidationError && e.code === "INVALID_REQUEST" && e.message === "Monto inválido"
    && e.solution === "Revisa amount_total" && e.status === 400);
  assert.equal(requests.length, 1);
});

test("401 y 409", async () => {
  on("GET", "/api/v1/dte/documents/a/", 401, { code: "INVALID_API_KEY", message: "m" });
  await assert.rejects(client.getDocument("a"), AuthenticationError);
  on("POST", "/api/v1/dte/factura/emit/", 409, { code: "FOLIOS_EXHAUSTED", message: "m" });
  await assert.rejects(client.emitFactura({}), (e) => e instanceof ConflictError && e.code === "FOLIOS_EXHAUSTED");
});

test("202 processing se devuelve, no es error", async () => {
  on("POST", "/api/v1/dte/boleta/emit/", 202, { status: "processing", dte_id: "z" });
  assert.equal((await client.emitBoleta({})).status, "processing");
});

test("falla de red: reintenta y luego lanza ConnectionFailedError", async () => {
  on("POST", "/api/v1/dte/boleta/emit/", 200, "HANGUP");
  const c = new SharkposClient({ apiKey: "k", baseUrl: url, maxRetries: 1, sleep: async () => {} });
  await assert.rejects(c.emitBoleta({}), ConnectionFailedError);
  assert.equal(requests.length, 2);
});

test("POST sin Idempotency-Key no se reintenta ante 5xx", async () => {
  on("POST", "/api/v1/dte/webhooks/", 500, { code: "INTERNAL_ERROR", message: "m" });
  await assert.rejects(client.createWebhook({ url: "https://ejemplo.cl/h" }), ServerError);
  assert.equal(requests.length, 1);
});

test("paginación por cursor", async () => {
  const p = "/api/v1/dte/documents/";
  on("GET", p, 200, { documents: [{ id: 1 }, { id: 2 }], has_more: true, next_cursor: "c1" });
  on("GET", p, 200, { documents: [{ id: 3 }], has_more: false, next_cursor: null });
  const ids = [];
  for await (const d of client.iterDocuments({ period: "2026-10", document_type: [33, 61], from: "2026-10-01" })) ids.push(d.id);
  assert.deepEqual(ids, [1, 2, 3]);
  assert.ok(requests[0].path.includes("document_type=33&document_type=61"));
  assert.ok(requests[0].path.includes("from=2026-10-01"));
  assert.ok(!requests[0].path.includes("cursor"));
  assert.ok(requests[1].path.includes("cursor=c1"));
});

test("descargas binarias", async () => {
  on("GET", "/api/v1/dte/boleta/u1/pdf/", 200, Buffer.from("%PDF-1.4 fake"));
  const pdf = await client.getBoletaPdf("u1", 58);
  assert.equal(pdf.toString(), "%PDF-1.4 fake");
  assert.ok(requests[0].path.includes("paper_width=58"));
});

test("verificar, cesión, anular folios, bandeja, RCV, webhooks", async () => {
  on("POST", "/api/v1/dte/verify/", 200, { status: "ok", verification: { result: "accepted" } });
  const v = await client.verifyDocument({ document_type: 33, folio: 5, issuer_rut: "76192083-9" });
  assert.equal(v.verification.result, "accepted");

  on("POST", "/api/v1/dte/verify/cesion/", 200, { status: "ok", cesion: { ceded: false } });
  assert.equal((await client.verifyCesion({ document_type: 33, folio: 5 })).cesion.ceded, false);

  on("POST", "/api/v1/dte/folios/annul/", 202, { status: "ok" });
  await client.annulFolios({ document_type: 33, folio_start: 40, folio_end: 45, reason: "Prueba" });
  const a = requests.at(-1);
  assert.deepEqual(a.body, { document_type: 33, folio_start: 40, folio_end: 45, reason: "Prueba" });
  assert.ok(a.headers["idempotency-key"]);

  on("POST", "/api/v1/dte/inbox/actions/", 200, { status: "ok", results: [] });
  const docs = [{ supplier_rut: "76086428-5", document_type: 33, folio: 10 }];
  await client.acceptInvoices(docs);
  assert.deepEqual(requests.at(-1).body, { action: "accept", documents: docs });
  await client.claimInvoices(docs, "RCD");
  assert.equal(requests.at(-1).body.claim_reason, "RCD");

  on("GET", "/api/v1/dte/rcv/summary/", 200, { status: "ok" });
  await client.getRcvSummary({ period: "2026-09", operation: "sales" });
  assert.ok(requests.at(-1).path.includes("operation=sales"));

  on("POST", "/api/v1/dte/webhooks/", 201, { webhook: { secret: "whsec_x" } });
  await client.createWebhook({ url: "https://ejemplo.cl/h", event_types: ["dte.accepted"] });
  assert.deepEqual(requests.at(-1).body.event_types, ["dte.accepted"]);
});

// ---- webhooks
const SECRET = "whsec_" + Buffer.from("super-secreto-de-prueba").toString("base64");
const signed = (payload, ts = Math.floor(Date.now() / 1000), id = "evt-1") => ({
  "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signWebhook(SECRET, id, ts, payload),
});

test("webhook: firma válida", () => {
  const payload = JSON.stringify({ type: "dte.accepted", data: { folio: 3 } });
  assert.equal(verifyWebhook(Buffer.from(payload), signed(payload), SECRET).type, "dte.accepted");
});

test("webhook: headers con mayúsculas y varias firmas", () => {
  const payload = '{"a":1}';
  const h = signed(payload);
  const out = verifyWebhook(payload, {
    "Webhook-Id": h["webhook-id"], "Webhook-Timestamp": h["webhook-timestamp"],
    "Webhook-Signature": "v1,AAAA " + h["webhook-signature"],
  }, SECRET);
  assert.deepEqual(out, { a: 1 });
});

test("webhook: cuerpo alterado, timestamp viejo y headers faltantes", () => {
  assert.throws(() => verifyWebhook('{"a":2}', signed('{"a":1}'), SECRET),
    (e) => e instanceof WebhookSignatureError && e.code === "WEBHOOK_SIGNATURE_INVALID");
  assert.throws(() => verifyWebhook('{"a":1}', signed('{"a":1}', Math.floor(Date.now() / 1000) - 3600), SECRET),
    (e) => e.code === "WEBHOOK_TIMESTAMP_EXPIRED");
  assert.throws(() => verifyWebhook("{}", {}, SECRET), (e) => e.code === "WEBHOOK_HEADERS_MISSING");
});
