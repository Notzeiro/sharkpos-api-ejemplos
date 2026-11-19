// Prueba el servidor MCP de punta a punta con un cliente MCP en memoria y un fetch simulado. Sin red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SharkposClient } from "sharkpos";
import { buildServer } from "../src/server.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function conectar(handler, options = {}) {
  const llamadas = [];
  const fetchFalso = async (url, init) => {
    llamadas.push({ url: String(url), init });
    return handler(String(url), init);
  };
  const sdk = new SharkposClient({ apiKey: "k", baseUrl: "http://simulado.local", fetch: fetchFalso, sleep: async () => {} });
  const server = buildServer(sdk, options);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, llamadas };
}

test("lista las herramientas y avisa que emitir genera un documento real", async () => {
  const { client } = await conectar(() => json(200, {}));
  const { tools } = await client.listTools();
  const nombres = tools.map((t) => t.name).sort();
  assert.deepEqual(nombres, [
    "sharkpos_consultar_estado", "sharkpos_descargar_pdf", "sharkpos_emitir_boleta", "sharkpos_emitir_documento",
    "sharkpos_listar_documentos", "sharkpos_resumen_documentos", "sharkpos_verificar_documento_sii",
  ]);
  for (const t of tools.filter((x) => x.name.startsWith("sharkpos_emitir"))) {
    assert.match(t.description, /REAL/);
    assert.match(t.description, /sandbox/);
  }
  assert.equal(tools.find((t) => t.name === "sharkpos_consultar_estado").annotations.readOnlyHint, true);
});

test("modo solo lectura no expone las herramientas de emisión", async () => {
  const { client } = await conectar(() => json(200, {}), { readOnly: true });
  const { tools } = await client.listTools();
  assert.ok(!tools.some((t) => t.name.startsWith("sharkpos_emitir")));
  assert.equal(tools.length, 5);
});

test("emitir boleta envía Bearer, clave de idempotencia y el cuerpo", async () => {
  const { client, llamadas } = await conectar(() => json(201, { status: "success", folio: 12, dte_id: "d1" }));
  const res = await client.callTool({
    name: "sharkpos_emitir_boleta",
    arguments: { items: [{ name: "Café", qty: 2, price: 1500 }], amount_total: 3000, idempotency_key: "venta-884" },
  });
  assert.ok(!res.isError);
  assert.equal(JSON.parse(res.content[0].text).folio, 12);
  const { url, init } = llamadas[0];
  assert.equal(url, "http://simulado.local/api/v1/dte/boleta/emit/");
  assert.equal(init.headers.Authorization, "Bearer k");
  assert.equal(init.headers["Idempotency-Key"], "venta-884");
  assert.equal(JSON.parse(init.body).amount_total, 3000);
});

test("emitir_documento enruta por tipo", async () => {
  const { client, llamadas } = await conectar(() => json(201, { status: "success", folio: 3 }));
  await client.callTool({ name: "sharkpos_emitir_documento", arguments: { tipo: "nota_credito", cuerpo: { x: 1 } } });
  assert.match(llamadas[0].url, /\/nota-credito\/emit\/$/);
  const mala = await client.callTool({ name: "sharkpos_emitir_documento", arguments: { tipo: "inexistente", cuerpo: {} } });
  assert.ok(mala.isError);
});

test("errores de la API llegan como isError con code y solución en español", async () => {
  const { client } = await conectar(() => json(409, { status: "error", code: "FOLIOS_EXHAUSTED", message: "No quedan folios.", solution: "Pide más folios." }));
  const res = await client.callTool({ name: "sharkpos_emitir_boleta", arguments: { items: [{ name: "x", price: 1 }], amount_total: 1 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /FOLIOS_EXHAUSTED/);
  assert.match(res.content[0].text, /Solución: Pide más folios/);
});

test("consultar estado, listar (from/to) y verificar", async () => {
  const { client, llamadas } = await conectar((url) => json(200, { status: "ok", url }));
  await client.callTool({ name: "sharkpos_consultar_estado", arguments: { dte_id: "0c7d7f0e-3b5e-4a4f-8f65-2f0c9b1d6a21" } });
  assert.match(llamadas[0].url, /documents\/0c7d7f0e-3b5e-4a4f-8f65-2f0c9b1d6a21\/$/);
  await client.callTool({ name: "sharkpos_listar_documentos", arguments: { desde: "2026-10-01", hasta: "2026-10-31", document_type: [33, 61] } });
  assert.match(llamadas[1].url, /from=2026-10-01&to=2026-10-31/);
  assert.match(llamadas[1].url, /document_type=33&document_type=61/);
  await client.callTool({ name: "sharkpos_verificar_documento_sii", arguments: { document_type: 33, folio: 5, issuer_rut: "76192083-9" } });
  assert.equal(llamadas[2].init.method, "POST");
  assert.equal(JSON.parse(llamadas[2].init.body).folio, 5);
});

test("el dte_id se valida (no permite rutas)", async () => {
  const { client, llamadas } = await conectar(() => json(200, {}));
  const res = await client.callTool({ name: "sharkpos_consultar_estado", arguments: { dte_id: "../../x" } });
  assert.ok(res.isError);
  assert.equal(llamadas.length, 0);
});

test("descargar PDF lo guarda en la carpeta indicada", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sharkpos-mcp-test-"));
  const { client, llamadas } = await conectar(() => new Response(Buffer.from("%PDF-1.4 fake"), { status: 200 }), { outputDir: dir });
  const res = await client.callTool({ name: "sharkpos_descargar_pdf", arguments: { dte_id: "abc12345-0000", paper_width: 58 } });
  assert.ok(!res.isError, res.content[0].text);
  const { path: file, bytes } = JSON.parse(res.content[0].text);
  assert.equal(bytes, 13);
  assert.equal((await readFile(file)).toString(), "%PDF-1.4 fake");
  assert.ok(file.startsWith(dir));
  assert.match(llamadas[0].url, /paper_width=58/);
});
