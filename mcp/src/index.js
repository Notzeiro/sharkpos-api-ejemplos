#!/usr/bin/env node
// Servidor MCP de SharkPOS API (transporte stdio).
// Variables de entorno (la API key NUNCA se pasa por argumentos):
//   SHARKPOS_API_KEY      obligatoria
//   SHARKPOS_ENV          "production" para usar https://api.sharkpos.cl; por defecto sandbox (no transmite al SII)
//   SHARKPOS_BASE_URL     sobreescribe la URL base
//   SHARKPOS_MCP_READONLY "1" desactiva las herramientas que emiten documentos
//   SHARKPOS_MCP_OUTPUT_DIR carpeta para los PDF descargados (por defecto, temporal del sistema)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SharkposClient } from "sharkpos";
import { buildServer } from "./server.js";

if (!process.env.SHARKPOS_API_KEY) {
  console.error(
    "Falta la variable de entorno SHARKPOS_API_KEY. Pide una llave de prueba gratis en https://api.sharkpos.cl/sandbox/",
  );
  process.exit(1);
}

const client = new SharkposClient({ sandbox: process.env.SHARKPOS_ENV !== "production" });
const server = buildServer(client, {
  readOnly: process.env.SHARKPOS_MCP_READONLY === "1",
  outputDir: process.env.SHARKPOS_MCP_OUTPUT_DIR || undefined,
});

console.error(`SharkPOS MCP listo (${client.baseUrl}${process.env.SHARKPOS_MCP_READONLY === "1" ? ", solo lectura" : ""}).`);
await server.connect(new StdioServerTransport());
