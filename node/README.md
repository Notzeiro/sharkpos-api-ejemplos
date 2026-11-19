# sharkpos (Node.js / TypeScript)

Cliente oficial de [SharkPOS API](https://api.sharkpos.cl) para emitir boletas y facturas electrónicas del SII.
ESM, tipos `.d.ts` incluidos, **cero dependencias** (usa `fetch` nativo de Node 18+).

```bash
npm install ./node        # desde este repositorio
```

```js
import { SharkposClient } from "sharkpos";

const client = new SharkposClient({ sandbox: true });       // lee SHARKPOS_API_KEY
const boleta = await client.emitBoleta(
  { amount_total: 3000, items: [{ name: "Café", qty: 2, price: 1500 }] },
  "venta-884",                                               // Idempotency-Key estable por venta
);
console.log(boleta.folio, (await client.getDocument(boleta.dte_id)).public_status);
```

- **Idempotencia**: todo POST de emisión lleva `Idempotency-Key`. Sin la tuya, el SDK genera un UUID4 y lo reutiliza
  en los reintentos de esa llamada. Para reintentos propios pasa siempre el id de tu venta.
- **Reintentos**: 429, 5xx y fallas de red con backoff exponencial, respetando `Retry-After`. Un 4xx distinto de
  429 no se reintenta.
- **Errores**: `SharkposError` con `code`, `message`, `solution` y `status`; subclases por tipo (`RateLimitError.retryAfter`...).
- **Paginación**: `for await (const doc of client.iterDocuments({ period: "2026-10" })) { ... }`
- **Webhooks**: `verifyWebhook(cuerpoCrudo, headers, secreto)`.
- **Endpoints sin método propio** (sucursales, BTE, partner...): `client.request("GET", "/api/v1/dte/branches/")`.

Pruebas: `npm test` (servidor simulado local, sin red).
