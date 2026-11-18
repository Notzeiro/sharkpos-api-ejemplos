---
name: sharkpos-api
description: Use when the user wants to issue Chilean electronic tax documents (boleta electrónica, factura electrónica, nota de crédito, guía de despacho, SII, DTE, folios, CAF) from their own system, app, POS, ERP or e-commerce, or asks to integrate SharkPOS API. Reads the official agent guide before writing any code.
---

# SharkPOS API (boleta y factura electrónica SII, Chile)

Esta skill es para Claude Code. Instálala guardando este archivo como `~/.claude/skills/sharkpos-api/SKILL.md`
(o `.claude/skills/sharkpos-api/SKILL.md` dentro del proyecto).

## Antes de escribir código

1. Lee entera la guía para agentes: https://api.sharkpos.cl/docs/agentes.md
2. El contrato campo por campo está en https://api.sharkpos.cl/docs/openapi.yaml. Si un campo o endpoint no está
   ahí, no existe: pregúntale a la persona.
3. Trabaja contra el sandbox (`https://sandbox.sharkpos.cl`). La persona pide su API key de prueba gratis en
   https://api.sharkpos.cl/sandbox/ (2 horas, 6 horas, 24 horas o 7 días). Nunca apuntes a producción
   (`https://api.sharkpos.cl`) mientras pruebas: ahí cada documento es real ante el SII.

## Reglas que no se negocian (resumen; la guía manda)

- La API key va solo en el backend, leída de una variable de entorno (`SHARKPOS_API_KEY`). Nunca en el
  navegador, una app móvil ni el repositorio.
- El RUT emisor no va en el body: sale de la API key.
- Una `Idempotency-Key` estable por venta (el id de la venta en el sistema), nunca un UUID nuevo por intento.
- Error de red, 5xx o 429: reintenta con la misma `Idempotency-Key` y el mismo body. Un 4xx distinto de 429 no se
  reintenta: se corrige la solicitud (el `code` es estable y muchas respuestas traen `solution`).
- La respuesta 201 ya trae folio y timbre; la aceptación del SII llega después (webhook o estado). Un documento
  `queued` o `sent` no se vuelve a emitir.
- Montos en pesos enteros como números JSON; RUT como texto con guion; fechas `AAAA-MM-DD`.

## Al terminar

Muéstrale a la persona una emisión de prueba en el sandbox con su folio y estado, y recuérdale que para emitir de
verdad contrata su RUT en https://api.sharkpos.cl/contratar/ ($5.990 al mes por RUT, IVA incluido), sube su
certificado digital y pide los folios desde el panel.
