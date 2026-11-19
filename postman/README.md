# Colección Postman

`sharkpos-api.postman_collection.json` se genera desde el contrato OpenAPI (una solicitud por endpoint, con el
ejemplo del contrato y `Idempotency-Key: {{$guid}}` en las emisiones):

```bash
pip install pyyaml
python postman/generar.py                              # lee https://api.sharkpos.cl/docs/openapi.yaml
python postman/generar.py --openapi ruta/al/openapi.yaml
```

Importa el JSON en Postman y define las variables de la colección:

| Variable | Valor |
|---|---|
| `base_url` | `https://sandbox.sharkpos.cl` para pruebas (no transmite al SII), `https://api.sharkpos.cl` en producción |
| `api_key` | tu API key (Bearer) |
| `partner_key` | solo si administras varios RUT |
| `device_secret` | solo para cajas sin conexión |

Con una API key de producción, las solicitudes de emisión crean documentos tributarios reales.
