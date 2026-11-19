# sharkpos (Python)

Cliente oficial de [SharkPOS API](https://api.sharkpos.cl) para emitir boletas y facturas electrónicas del SII.
Sin dependencias: usa solo la librería estándar (`urllib`), así no choca con ninguna otra versión en tu servidor.

```bash
pip install ./python        # desde este repositorio
```

```python
from sharkpos import SharkposClient

client = SharkposClient(sandbox=True)          # lee SHARKPOS_API_KEY
boleta = client.emit_boleta({"amount_total": 3000, "items": [{"name": "Café", "qty": 2, "price": 1500}]},
                            idempotency_key="venta-884")
print(boleta["folio"], client.get_document(boleta["dte_id"])["status"])
```

- **Idempotencia**: todo POST de emisión lleva `Idempotency-Key`. Si no la pasas, el SDK genera un UUID4 y lo
  reutiliza en los reintentos de esa llamada. Para reintentos propios (tu cola, tu proceso reiniciado) pasa siempre el
  id de tu venta.
- **Reintentos**: 429, 5xx y fallas de red, con backoff exponencial y respetando `Retry-After`. Un 4xx
  distinto de 429 no se reintenta.
- **Errores**: `SharkposError` con `code`, `message`, `solution` y `status_code`; subclases por tipo.
- **Paginación**: `for doc in client.iter_documents(period="2026-10"): ...`
- **Webhooks**: `verify_webhook(cuerpo_crudo, headers, secreto)`.
- **Endpoints sin método propio** (sucursales, BTE, partner...): `client.request("GET", "/api/v1/dte/branches/")`.

Pruebas: `python -m unittest discover -s tests` (servidor simulado local, sin red).
