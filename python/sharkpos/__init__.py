"""SharkPOS API: cliente oficial para boleta y factura electrónica del SII (Chile)."""

from .client import PRODUCTION_URL, SANDBOX_URL, VERSION, SharkposClient
from .errors import (
    AuthenticationError,
    ConflictError,
    ConnectionFailedError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    ServerError,
    SharkposError,
    ValidationError,
    WebhookSignatureError,
)
from .webhooks import verify_webhook

__version__ = VERSION
__all__ = [
    "SharkposClient", "verify_webhook", "SharkposError", "AuthenticationError", "PermissionDeniedError",
    "NotFoundError", "ConflictError", "ValidationError", "RateLimitError", "ServerError",
    "ConnectionFailedError", "WebhookSignatureError", "PRODUCTION_URL", "SANDBOX_URL",
]
