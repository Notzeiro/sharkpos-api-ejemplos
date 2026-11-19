# SharkPOS API · ejemplos

Ejemplos para emitir **boletas y facturas electrónicas del SII (Chile)** desde tu sistema con
[SharkPOS API](https://api.sharkpos.cl): recibes JSON, nosotros firmamos el XML, timbramos con el CAF, lo enviamos
al SII y te avisamos el resultado.

| Carpeta | Qué hay | Guía |
|---|---|---|
| `python/` | **SDK `sharkpos`** (sin dependencias) y el ejemplo suelto `boleta.py` | [Python](https://api.sharkpos.cl/guias/boleta-electronica-python/) |
| `node/` | **SDK `sharkpos`** (ESM, tipos, `fetch` nativo, Node 18+) y el ejemplo `boleta.mjs` | [Node](https://api.sharkpos.cl/guias/boleta-electronica-node/) |
| `php/` | Cliente de un archivo `SharkposClient.php` (cURL) y ejemplos de cURL y Laravel | [PHP](https://api.sharkpos.cl/guias/boleta-electronica-php/) |
| `postman/` | Colección Postman generada desde el OpenAPI (`generar.py`) | |
| `mcp/` | Servidor MCP para que agentes de IA emitan, consulten y verifiquen | |
| `claude-code/` | Skill para que Claude Code integre la API siguiendo las reglas oficiales | [Con Claude Code](https://api.sharkpos.cl/guias/boleta-electronica-con-claude-code/) |

## Empezar

1. Pide tu API key de prueba gratis en <https://api.sharkpos.cl/sandbox/> (2 horas, 6 horas, 24 horas o 7 días;
   empresa de prueba con certificado y folios ya cargados; el SII está simulado).
2. `export SHARKPOS_API_KEY=...` y ejecuta el ejemplo de tu lenguaje. La base URL de pruebas es
   `https://sandbox.sharkpos.cl`.
3. Documentación completa: <https://api.sharkpos.cl/docs> · Contrato OpenAPI: <https://api.sharkpos.cl/docs/openapi.yaml>
   · Guía para agentes de IA: <https://api.sharkpos.cl/docs/agentes.md>

Para emitir de verdad contratas tu RUT en <https://api.sharkpos.cl/contratar/>: $5.990 al mes por RUT, IVA incluido.
¿Tu software emite por muchos clientes? Mira <https://api.sharkpos.cl/integradores/>.

## Instalación y ejemplo mínimo

Los tres clientes hacen lo mismo: Bearer, `Idempotency-Key`, reintentos con backoff ante 429/5xx/red, errores con
`code`, `message` y `solution`. Todos los ejemplos usan el sandbox (`sandbox=True`); quítalo para producción.

**Python** (`pip install ./python`)

```python
from sharkpos import SharkposClient
client = SharkposClient(sandbox=True)  # lee SHARKPOS_API_KEY
boleta = client.emit_boleta({"amount_total": 3000, "items": [{"name": "Café", "qty": 2, "price": 1500}]}, idempotency_key="venta-884")
print(boleta["folio"], client.get_document(boleta["dte_id"])["public_status"])
```

**Node / TypeScript** (`npm install ./node`)

```js
import { SharkposClient } from "sharkpos";
const client = new SharkposClient({ sandbox: true }); // lee SHARKPOS_API_KEY
const boleta = await client.emitBoleta({ amount_total: 3000, items: [{ name: "Café", qty: 2, price: 1500 }] }, "venta-884");
console.log(boleta.folio, (await client.getDocument(boleta.dte_id)).public_status);
```

**PHP** (copia `php/SharkposClient.php`)

```php
require 'SharkposClient.php';
$client = new SharkposClient(null, true); // lee SHARKPOS_API_KEY, true = sandbox
$boleta = $client->emitirBoleta(['amount_total' => 3000, 'items' => [['name' => 'Café', 'qty' => 2, 'price' => 1500]]], 'venta-884');
echo $boleta['folio'], ' ', $client->estado($boleta['dte_id'])['public_status'];
```

**Agentes de IA**: el servidor MCP de `mcp/` expone la API como herramientas; ver [mcp/README.md](mcp/README.md).

## Reglas que importan

- La API key va solo en el backend (variable de entorno), nunca en el navegador ni en el repositorio.
- Una `Idempotency-Key` estable por venta. Ante error de red, 5xx o 429, reintenta con la misma clave y el mismo body.
- Un 4xx distinto de 429 no se reintenta: corrige la solicitud (`code` y `solution` dicen qué hacer).

Licencia MIT.
