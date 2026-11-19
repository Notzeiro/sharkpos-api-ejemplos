"""Verificación de webhooks firmados (Standard Webhooks, HMAC-SHA256)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Dict, Mapping, Optional, Union

from .errors import WebhookSignatureError

TOLERANCIA_SEGUNDOS = 300  # 5 minutos, como pide la guía de webhooks


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None


def sign(secret: str, msg_id: str, timestamp: Union[int, str], payload: Union[bytes, str]) -> str:
    """Firma ``{id}.{timestamp}.{cuerpo}``; útil para tests. Devuelve ``v1,<base64>``."""
    body = payload.encode("utf-8") if isinstance(payload, str) else payload
    key = base64.b64decode(secret.removeprefix("whsec_"))
    signed = f"{msg_id}.{timestamp}.".encode("utf-8") + body
    digest = hmac.new(key, signed, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode("ascii")


def verify_webhook(
    payload: Union[bytes, str],
    headers: Mapping[str, str],
    secret: str,
    tolerance: int = TOLERANCIA_SEGUNDOS,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Verifica la firma de un webhook y devuelve el evento ya parseado.

    ``payload`` debe ser el cuerpo CRUDO tal como llegó (antes de parsear el JSON).
    Lanza :class:`WebhookSignatureError` si falta un header, la firma no coincide
    o el timestamp difiere más de ``tolerance`` segundos.
    """
    msg_id = _header(headers, "webhook-id")
    timestamp = _header(headers, "webhook-timestamp")
    signatures = _header(headers, "webhook-signature")
    if not (msg_id and timestamp and signatures):
        raise WebhookSignatureError(
            "Faltan headers del webhook (webhook-id, webhook-timestamp o webhook-signature).",
            code="WEBHOOK_HEADERS_MISSING",
        )
    try:
        ts = int(timestamp)
    except ValueError:
        raise WebhookSignatureError("El timestamp del webhook no es válido.", code="WEBHOOK_TIMESTAMP_INVALID")
    actual = time.time() if now is None else now
    if abs(actual - ts) > tolerance:
        raise WebhookSignatureError(
            "El timestamp del webhook está fuera de la ventana permitida (posible reenvío).",
            code="WEBHOOK_TIMESTAMP_EXPIRED",
        )
    esperada = sign(secret, msg_id, timestamp, payload)
    # El header puede traer varias firmas separadas por espacio (rotación de secreto).
    for candidata in signatures.split(" "):
        if hmac.compare_digest(candidata.strip(), esperada):
            raw = payload.decode("utf-8") if isinstance(payload, bytes) else payload
            return json.loads(raw)
    raise WebhookSignatureError("La firma del webhook no coincide.", code="WEBHOOK_SIGNATURE_INVALID")
