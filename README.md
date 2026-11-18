# SharkPOS API · ejemplos

Ejemplos para emitir **boletas y facturas electrónicas del SII (Chile)** desde tu sistema con
[SharkPOS API](https://api.sharkpos.cl): recibes JSON, nosotros firmamos el XML, timbramos con el CAF, lo enviamos
al SII y te avisamos el resultado.

| Carpeta | Qué hay | Guía |
|---|---|---|
| `python/` | Emitir una boleta, reintentar con la misma `Idempotency-Key` y consultar el estado | [Python](https://api.sharkpos.cl/guias/boleta-electronica-python/) |
| `node/` | Lo mismo con `fetch` (Node 18+) | [Node](https://api.sharkpos.cl/guias/boleta-electronica-node/) |
| `php/` | cURL y Laravel | [PHP](https://api.sharkpos.cl/guias/boleta-electronica-php/) |
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

## Reglas que importan

- La API key va solo en el backend (variable de entorno), nunca en el navegador ni en el repositorio.
- Una `Idempotency-Key` estable por venta. Ante error de red, 5xx o 429, reintenta con la misma clave y el mismo body.
- Un 4xx distinto de 429 no se reintenta: corrige la solicitud (`code` y `solution` dicen qué hacer).

Licencia MIT.
