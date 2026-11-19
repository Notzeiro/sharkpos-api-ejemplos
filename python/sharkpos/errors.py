"""Excepciones del SDK. Todas heredan de :class:`SharkposError`."""

from __future__ import annotations

from typing import Any, Dict, Optional


class SharkposError(Exception):
    """Error devuelto por la API (o fallo de red).

    Atributos:
        code: código estable de la API (p. ej. ``FOLIOS_EXHAUSTED``) para tu lógica.
        message: qué pasó, en español.
        solution: qué hacer (cuando la API lo entrega).
        status_code: código HTTP (``None`` si no hubo respuesta).
        body: cuerpo JSON completo de la respuesta, si lo había.
    """

    def __init__(
        self,
        message: str,
        code: str = "SHARKPOS_ERROR",
        solution: Optional[str] = None,
        status_code: Optional[int] = None,
        body: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.solution = solution
        self.status_code = status_code
        self.body = body

    def __str__(self) -> str:
        partes = [f"[{self.code}] {self.message}"]
        if self.solution:
            partes.append(f"Solución: {self.solution}")
        if self.status_code:
            partes.append(f"(HTTP {self.status_code})")
        return " ".join(partes)


class AuthenticationError(SharkposError):
    """401: API key ausente o inválida."""


class PermissionDeniedError(SharkposError):
    """402/403: la API key no tiene acceso (plan, suscripción vencida, llave de solo lectura...)."""


class NotFoundError(SharkposError):
    """404: el recurso no existe para esta API key."""


class ConflictError(SharkposError):
    """409: conflicto (folios agotados, idempotencia, documento no emitido...)."""


class ValidationError(SharkposError):
    """400/422: la solicitud es inválida. Corrígela; no se reintenta."""


class RateLimitError(SharkposError):
    """429: límite superado. ``retry_after`` trae los segundos a esperar, si la API los dio."""

    def __init__(self, *args: Any, retry_after: Optional[float] = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.retry_after = retry_after


class ServerError(SharkposError):
    """5xx: falla del servidor o del SII. Es seguro reintentar con la misma Idempotency-Key."""


class ConnectionFailedError(SharkposError):
    """No hubo respuesta: red caída, DNS o tiempo de espera agotado."""


class WebhookSignatureError(SharkposError):
    """La firma del webhook no es válida o el timestamp es demasiado antiguo."""


def error_for_status(
    status: int, body: Optional[Dict[str, Any]], retry_after: Optional[float] = None
) -> SharkposError:
    """Construye la excepción adecuada a partir de una respuesta de error."""
    body = body if isinstance(body, dict) else {}
    message = body.get("message") or f"La API respondió con error HTTP {status}."
    code = body.get("code") or f"HTTP_{status}"
    solution = body.get("solution")
    kwargs = dict(code=code, solution=solution, status_code=status, body=body or None)
    if status == 401:
        return AuthenticationError(message, **kwargs)
    if status in (402, 403):
        return PermissionDeniedError(message, **kwargs)
    if status == 404:
        return NotFoundError(message, **kwargs)
    if status == 409:
        return ConflictError(message, **kwargs)
    if status == 429:
        return RateLimitError(message, retry_after=retry_after, **kwargs)
    if status >= 500:
        return ServerError(message, **kwargs)
    return ValidationError(message, **kwargs)
