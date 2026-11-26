# SharkPOS MCP

Servidor [MCP](https://modelcontextprotocol.io) para que un agente de IA (Claude Code, Claude Desktop...) use
SharkPOS API: emitir documentos, consultar su estado, listar, verificar ante el SII y bajar PDF.
Usa el SDK `../node` y el SDK oficial `@modelcontextprotocol/sdk`.

## Instalar

```bash
cd mcp
npm install          # instala el SDK de MCP, zod y el SDK local de SharkPOS (../node)
npm test             # prueba con un servidor simulado, sin red
```

Necesitas Node 18 o superior y una API key. Pide una de prueba gratis en <https://api.sharkpos.cl/sandbox/>.

## Variables de entorno

La API key se lee **solo** de la variable de entorno; el servidor no acepta llaves por argumentos.

| Variable | Qué hace |
|---|---|
| `SHARKPOS_API_KEY` | Obligatoria. |
| `SHARKPOS_ENV` | `production` usa `https://api.sharkpos.cl`. Por defecto usa el **sandbox** (`https://sandbox.sharkpos.cl`, no transmite al SII). |
| `SHARKPOS_MCP_READONLY` | `1` desactiva las herramientas que emiten documentos (solo consulta). |
| `SHARKPOS_MCP_OUTPUT_DIR` | Carpeta donde se guardan los PDF (por defecto una carpeta temporal). |
| `SHARKPOS_BASE_URL` | Sobreescribe la URL base. |

## Instalar desde npm (sin clonar el repo)

```bash
claude mcp add sharkpos -e SHARKPOS_API_KEY=tu_llave_de_prueba -- npx -y sharkpos-mcp
```

Codex: `codex mcp add sharkpos --env SHARKPOS_API_KEY=tu_llave_de_prueba -- npx -y sharkpos-mcp`.
Solo para leer la documentación, sin API key, usa el MCP remoto: `claude mcp add --transport http sharkpos-docs https://api.sharkpos.cl/mcp`.

## Agregarlo a Claude Code

```bash
claude mcp add sharkpos -e SHARKPOS_API_KEY=tu_llave_de_prueba -- node /ruta/completa/sharkpos-api-ejemplos/mcp/src/index.js
```

Agrega `-s user` para tenerlo en todos tus proyectos. Comprueba con `claude mcp list`.

## Agregarlo a Claude Desktop

Edita `claude_desktop_config.json` (menú Configuración > Desarrollador > Editar configuración) y reinicia la app:

```json
{
  "mcpServers": {
    "sharkpos": {
      "command": "node",
      "args": ["/ruta/completa/sharkpos-api-ejemplos/mcp/src/index.js"],
      "env": { "SHARKPOS_API_KEY": "tu_llave_de_prueba" }
    }
  }
}
```

En Windows usa barras normales o dobles barras invertidas en la ruta.

## Herramientas

| Herramienta | Qué hace | Emite documento real |
|---|---|---|
| `sharkpos_emitir_boleta` | Boleta electrónica (39) o exenta (41) | Sí, con key de producción |
| `sharkpos_emitir_documento` | Factura, factura exenta, notas, factura de compra, liquidación, exportación, guía | Sí, con key de producción |
| `sharkpos_consultar_estado` | Estado de un documento por `dte_id` | No |
| `sharkpos_listar_documentos` | Listado con filtros y cursor | No |
| `sharkpos_resumen_documentos` | Totales del período por tipo y estado | No |
| `sharkpos_verificar_documento_sii` | Pregunta al SII por un documento | No |
| `sharkpos_descargar_pdf` | Guarda el PDF en disco y devuelve la ruta | No |

Las herramientas de emisión advierten en su descripción que, con una API key de producción, crean un documento
tributario real y no se puede deshacer; con una key de sandbox no transmiten al SII. Un buen hábito: trabaja con la
key de sandbox y pasa a producción solo cuando una persona lo decida (`SHARKPOS_ENV=production`).
