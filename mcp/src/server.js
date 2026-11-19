import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SharkposError } from "sharkpos";

const REAL_DOC_WARNING =
  "ATENCIÓN: con una API key de PRODUCCIÓN esto genera un documento tributario REAL, con folio, firmado y " +
  "enviado al SII; no se puede deshacer (solo se corrige con una nota de crédito). Con una API key de sandbox " +
  "no transmite al SII y no tiene efecto tributario. Antes de emitir confirma con la persona los datos y el monto.";

const ID = z.string().regex(/^[0-9a-fA-F-]{8,64}$/, "Debe ser el dte_id (UUID) del documento.");
const PERIOD = z.string().regex(/^\d{4}-\d{2}$/, "Formato AAAA-MM, por ejemplo 2026-10.");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato AAAA-MM-DD.");

const DOC_TYPES = {
  factura: ["emitFactura", "Factura electrónica (33)"],
  factura_exenta: ["emitFacturaExenta", "Factura exenta electrónica (34)"],
  nota_credito: ["emitNotaCredito", "Nota de crédito electrónica (61)"],
  nota_debito: ["emitNotaDebito", "Nota de débito electrónica (56)"],
  factura_compra: ["emitFacturaCompra", "Factura de compra electrónica (46)"],
  liquidacion_factura: ["emitLiquidacionFactura", "Liquidación-factura electrónica (43)"],
  exportacion: ["emitExportacion", "Factura de exportación electrónica (110)"],
  nota_debito_exportacion: ["emitNotaDebitoExportacion", "Nota de débito de exportación (111)"],
  nota_credito_exportacion: ["emitNotaCreditoExportacion", "Nota de crédito de exportación (112)"],
  guia_despacho: ["emitGuiaDespacho", "Guía de despacho electrónica (52)"],
};

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  if (err instanceof SharkposError) {
    const partes = [`[${err.code}] ${err.message}`];
    if (err.solution) partes.push(`Solución: ${err.solution}`);
    if (err.status) partes.push(`(HTTP ${err.status})`);
    return { isError: true, content: [{ type: "text", text: partes.join(" ") }] };
  }
  return { isError: true, content: [{ type: "text", text: `Error inesperado: ${err?.message ?? err}` }] };
}

/** Envuelve un handler para devolver errores de la API como resultado de herramienta (no como excepción). */
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err);
  }
};

/**
 * Crea el servidor MCP.
 * @param {import("sharkpos").SharkposClient} client
 * @param {{readOnly?: boolean, outputDir?: string}} [options]
 *   readOnly: no registra las herramientas que emiten documentos.
 *   outputDir: carpeta donde se guardan los PDF descargados.
 */
export function buildServer(client, options = {}) {
  const outputDir = options.outputDir ?? path.join(os.tmpdir(), "sharkpos-mcp");
  const server = new McpServer({ name: "sharkpos", version: "0.1.0" });

  // ------------------------------------------------------------- Emisión
  if (!options.readOnly) {
    server.registerTool(
      "sharkpos_emitir_boleta",
      {
        title: "Emitir boleta electrónica",
        description:
          "Emite una boleta electrónica (39) o exenta (41) ante el SII de Chile. " + REAL_DOC_WARNING +
          " Los montos son pesos chilenos enteros; amount_total debe ser la suma de las líneas (qty × price, precios con IVA). " +
          "Pasa siempre idempotency_key estable por venta (por ejemplo el id de la venta): reintentar con la misma clave " +
          "no emite una segunda boleta.",
        inputSchema: {
          items: z.array(z.object({
            name: z.string().min(1).max(80),
            qty: z.number().positive().default(1),
            price: z.number().nonnegative().describe("Precio unitario con IVA, en pesos."),
            description: z.string().max(1000).optional(),
          })).min(1).max(1000),
          amount_total: z.number().int().positive().describe("Suma exacta de las líneas, en pesos."),
          document_type: z.union([z.literal(39), z.literal(41)]).default(39),
          medio_pago: z.number().int().min(1).max(5).optional(),
          receptor_rut: z.string().optional().describe("Con guion, p. ej. 12345678-5. Por defecto consumidor final."),
          receptor_name: z.string().max(100).optional(),
          receptor_email: z.string().email().optional(),
          idempotency_key: z.string().min(8).max(128).optional()
            .describe("Clave estable por venta (8 a 128 caracteres). Si falta, se genera una nueva por llamada."),
        },
        annotations: { title: "Emitir boleta electrónica", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safe(async ({ idempotency_key, ...body }) => ok(await client.emitBoleta(body, idempotency_key))),
    );

    server.registerTool(
      "sharkpos_emitir_documento",
      {
        title: "Emitir factura, nota, guía u otro documento",
        description:
          "Emite una factura (33), factura exenta (34), nota de crédito (61), nota de débito (56), factura de compra (46), " +
          "liquidación-factura (43), exportación (110/111/112) o guía de despacho (52). " + REAL_DOC_WARNING +
          " El campo 'cuerpo' sigue el contrato oficial https://api.sharkpos.cl/docs/openapi.yaml (receptor_rut, receptor_name, " +
          "receptor_giro, receptor_direccion, receptor_comuna e items, entre otros); no inventes campos que no estén ahí. " +
          "Las notas de crédito y débito exigen referencia al documento que corrigen.",
        inputSchema: {
          tipo: z.enum(Object.keys(DOC_TYPES)).describe(
            Object.entries(DOC_TYPES).map(([k, v]) => `${k} = ${v[1]}`).join("; ")),
          cuerpo: z.record(z.any()).describe("Cuerpo JSON del documento según el contrato OpenAPI."),
          idempotency_key: z.string().min(8).max(128).optional()
            .describe("Clave estable por documento. Si falta, se genera una nueva por llamada."),
        },
        annotations: { title: "Emitir documento tributario", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      safe(async ({ tipo, cuerpo, idempotency_key }) => ok(await client[DOC_TYPES[tipo][0]](cuerpo, idempotency_key))),
    );
  }

  // ----------------------------------------------------------- Consultas
  server.registerTool(
    "sharkpos_consultar_estado",
    {
      title: "Consultar estado de un documento",
      description:
        "Estado vigente de un documento emitido (cualquier tipo): si el SII lo aceptó, rechazó o sigue pendiente. " +
        "Solo lectura. Usa el dte_id que devolvió la emisión.",
      inputSchema: { dte_id: ID },
      annotations: { title: "Consultar estado", readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ dte_id }) => ok(await client.getDocument(dte_id))),
  );

  server.registerTool(
    "sharkpos_listar_documentos",
    {
      title: "Listar documentos emitidos",
      description:
        "Lista una página de documentos emitidos, con filtros. Solo lectura. Si has_more es true, vuelve a llamar con " +
        "cursor = next_cursor para la página siguiente.",
      inputSchema: {
        period: PERIOD.optional().describe("Mes de emisión. No se combina con desde/hasta."),
        desde: DATE.optional(),
        hasta: DATE.optional(),
        document_type: z.array(z.number().int()).optional().describe("Por ejemplo [33, 61]."),
        status: z.array(z.string()).optional().describe("Por ejemplo [\"accepted\"], [\"rejected\"] o [\"pending\"]."),
        limit: z.number().int().min(1).max(500).default(50),
        cursor: z.string().optional(),
      },
      annotations: { title: "Listar documentos", readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ desde, hasta, ...resto }) => ok(await client.listDocuments({ ...resto, from: desde, to: hasta }))),
  );

  server.registerTool(
    "sharkpos_resumen_documentos",
    {
      title: "Resumen de documentos del período",
      description:
        "Cantidades y montos (neto, exento, IVA, total) del período por tipo y estado. Solo lectura. " +
        "Las notas de crédito suman en positivo: réstalas al cuadrar ventas.",
      inputSchema: {
        period: PERIOD.optional(),
        desde: DATE.optional(),
        hasta: DATE.optional(),
        document_type: z.array(z.number().int()).optional(),
      },
      annotations: { title: "Resumen del período", readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ desde, hasta, ...resto }) => ok(await client.summarizeDocuments({ ...resto, from: desde, to: hasta }))),
  );

  server.registerTool(
    "sharkpos_verificar_documento_sii",
    {
      title: "Verificar un documento ante el SII",
      description:
        "Pregunta al SII si un documento (propio o recibido de un tercero) existe y está aceptado. Solo lectura; no emite " +
        "nada. No sirve para boletas (39/41). Entrega tipo, folio, RUT emisor y receptor, fecha y monto, o el xml del documento. " +
        "Requiere certificado digital cargado en el RUT.",
      inputSchema: {
        document_type: z.number().int().optional().describe("33, 34, 43, 46, 52, 56, 61, 110, 111 o 112."),
        folio: z.number().int().positive().optional(),
        issuer_rut: z.string().optional(),
        receptor_rut: z.string().optional(),
        issue_date: DATE.optional(),
        amount_total: z.number().int().optional(),
        xml: z.string().optional().describe("<DTE> o <EnvioDTE>; lo que falte se lee de él."),
      },
      annotations: { title: "Verificar ante el SII", readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => ok(await client.verifyDocument(args))),
  );

  server.registerTool(
    "sharkpos_descargar_pdf",
    {
      title: "Descargar el PDF de un documento",
      description:
        "Descarga el PDF de un documento emitido y lo guarda en una carpeta local; devuelve la ruta del archivo. " +
        "Boletas (39/41) en formato térmico de 58 u 80 mm; el resto en formato carta. No emite ni modifica nada.",
      inputSchema: {
        dte_id: ID,
        tipo: z.enum(["boleta", "otro"]).default("boleta").describe("'boleta' para 39/41; 'otro' para factura, nota o guía."),
        paper_width: z.union([z.literal(58), z.literal(80)]).default(80).describe("Solo boletas."),
      },
      annotations: { title: "Descargar PDF", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ dte_id, tipo, paper_width }) => {
      const pdf = tipo === "boleta" ? await client.getBoletaPdf(dte_id, paper_width) : await client.getB2bPdf(dte_id);
      await mkdir(outputDir, { recursive: true });
      const file = path.join(outputDir, `${tipo === "boleta" ? "boleta" : "documento"}-${dte_id}.pdf`);
      await writeFile(file, pdf);
      return ok({ path: file, bytes: pdf.length });
    }),
  );

  return server;
}
