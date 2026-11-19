"""Cliente HTTP de SharkPOS API.

Usa solo la librería estándar (``urllib``): el SDK no tiene dependencias, así que
se instala en cualquier servidor sin conflictos de versiones.
"""

from __future__ import annotations

import json
import os
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple

from .errors import ConnectionFailedError, SharkposError, error_for_status
from .types import JSON, Document, DocumentStatus

PRODUCTION_URL = "https://api.sharkpos.cl"
SANDBOX_URL = "https://sandbox.sharkpos.cl"
VERSION = "0.1.0"
_RETRY_STATUS = (429, 500, 502, 503, 504)
_MAX_WAIT = 60.0


class Response:
    """Respuesta cruda (para descargas binarias)."""

    def __init__(self, status: int, headers: Mapping[str, str], content: bytes) -> None:
        self.status = status
        self.headers = headers
        self.content = content


class SharkposClient:
    """Cliente de la API. Una instancia sirve para todo un RUT (una API key).

    Args:
        api_key: API key del emisor. Si falta, se lee ``SHARKPOS_API_KEY``.
        sandbox: usa ``https://sandbox.sharkpos.cl`` (no transmite al SII).
        base_url: sobreescribe la URL base (también ``SHARKPOS_BASE_URL``).
        timeout: segundos por intento.
        max_retries: reintentos ante 429, 5xx o falla de red (backoff exponencial).
        backoff: espera base en segundos; el intento n espera ``backoff * 2**n`` (con jitter).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        sandbox: bool = False,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 3,
        backoff: float = 0.5,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        key = api_key or os.environ.get("SHARKPOS_API_KEY")
        if not key:
            raise SharkposError(
                "Falta la API key. Pásala al crear el cliente o define SHARKPOS_API_KEY.",
                code="API_KEY_MISSING",
                solution="Pide una llave de prueba gratis en https://api.sharkpos.cl/sandbox/",
            )
        self._api_key = key
        url = base_url or os.environ.get("SHARKPOS_BASE_URL") or (SANDBOX_URL if sandbox else PRODUCTION_URL)
        self.base_url = url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max(0, int(max_retries))
        self.backoff = backoff
        self._sleep = sleep

    def __repr__(self) -> str:  # nunca muestra la API key
        return f"SharkposClient(base_url={self.base_url!r})"

    # ------------------------------------------------------------------ HTTP

    def _wait(self, attempt: int, retry_after: Optional[float]) -> float:
        if retry_after is not None:
            return min(max(retry_after, 0.0), _MAX_WAIT)
        espera = self.backoff * (2 ** attempt)
        return min(espera + random.uniform(0, espera / 4), _MAX_WAIT)

    @staticmethod
    def _query(params: Optional[Mapping[str, Any]]) -> str:
        pairs: List[Tuple[str, str]] = []
        for key, value in (params or {}).items():
            if value is None:
                continue
            if isinstance(value, bool):
                pairs.append((key, "true" if value else "false"))
            elif isinstance(value, (list, tuple)):
                pairs.extend((key, str(v)) for v in value)
            else:
                pairs.append((key, str(value)))
        return urllib.parse.urlencode(pairs)

    def request_raw(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        json_body: Optional[Any] = None,
        idempotency_key: Optional[str] = None,
        retry_unsafe: bool = False,
    ) -> Response:
        """Hace la solicitud con reintentos y devuelve la respuesta cruda.

        Un POST solo se reintenta ante 5xx o falla de red si lleva ``Idempotency-Key``
        (o ``retry_unsafe=True`` para consultas que no cambian nada). El 429 siempre se
        reintenta: la API no procesó la solicitud.
        """
        url = self.base_url + path
        query = self._query(params)
        if query:
            url += "?" + query
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "User-Agent": f"sharkpos-python/{VERSION}",
        }
        data = None
        if json_body is not None:
            data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        method = method.upper()
        safe = method in ("GET", "HEAD") or bool(idempotency_key) or retry_unsafe

        attempt = 0
        while True:
            retry_after: Optional[float] = None
            try:
                req = urllib.request.Request(url, data=data, headers=headers, method=method)
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return Response(resp.status, dict(resp.headers.items()), resp.read())
            except urllib.error.HTTPError as exc:
                raw = exc.read()
                exc.close()
                hdrs = dict(exc.headers.items()) if exc.headers else {}
                ra = next((v for k, v in hdrs.items() if k.lower() == "retry-after"), None)
                try:
                    retry_after = float(ra) if ra is not None else None
                except ValueError:
                    retry_after = None
                reintentable = exc.code in _RETRY_STATUS and (exc.code == 429 or safe)
                if not reintentable or attempt >= self.max_retries:
                    try:
                        body = json.loads(raw.decode("utf-8")) if raw else {}
                    except (ValueError, UnicodeDecodeError):
                        body = {}
                    raise error_for_status(exc.code, body, retry_after) from None
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
                if not safe or attempt >= self.max_retries:
                    raise ConnectionFailedError(
                        f"No se pudo conectar con SharkPOS API ({exc}).",
                        code="CONNECTION_FAILED",
                        solution="Revisa tu conexión y reintenta con la misma Idempotency-Key.",
                    ) from exc
            self._sleep(self._wait(attempt, retry_after))
            attempt += 1

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        json_body: Optional[Any] = None,
        idempotency_key: Optional[str] = None,
        retry_unsafe: bool = False,
    ) -> JSON:
        """Solicitud genérica que devuelve el JSON. Sirve para endpoints sin método propio."""
        resp = self.request_raw(
            method, path, params=params, json_body=json_body,
            idempotency_key=idempotency_key, retry_unsafe=retry_unsafe,
        )
        if not resp.content:
            return {}
        try:
            return json.loads(resp.content.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise SharkposError(
                "La respuesta de la API no es JSON válido.", code="INVALID_RESPONSE", status_code=resp.status
            ) from None

    def _emit(self, path: str, body: Mapping[str, Any], idempotency_key: Optional[str]) -> JSON:
        # Una sola clave por llamada: todos los reintentos internos la reutilizan.
        key = idempotency_key or str(uuid.uuid4())
        return self.request("POST", path, json_body=dict(body), idempotency_key=key)

    # --------------------------------------------------------------- Emisión
    # Cada método acepta ``idempotency_key``. Usa el id de tu venta para que un
    # reintento tuyo (no solo del SDK) nunca emita dos documentos. Sin ella, el SDK
    # genera un UUID4 y lo reutiliza en los reintentos de esa misma llamada.
    # Con una API key de producción estos métodos EMITEN un documento tributario real.

    def emit_boleta(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Boleta electrónica (39) o exenta (41)."""
        return self._emit("/api/v1/dte/boleta/emit/", body, idempotency_key)

    def emit_factura(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Factura electrónica (33)."""
        return self._emit("/api/v1/dte/factura/emit/", body, idempotency_key)

    def emit_factura_exenta(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Factura no afecta o exenta electrónica (34)."""
        return self._emit("/api/v1/dte/factura-exenta/emit/", body, idempotency_key)

    def emit_nota_credito(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Nota de crédito electrónica (61)."""
        return self._emit("/api/v1/dte/nota-credito/emit/", body, idempotency_key)

    def emit_nota_debito(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Nota de débito electrónica (56)."""
        return self._emit("/api/v1/dte/nota-debito/emit/", body, idempotency_key)

    def emit_factura_compra(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Factura de compra electrónica (46)."""
        return self._emit("/api/v1/dte/factura-compra/emit/", body, idempotency_key)

    def emit_liquidacion_factura(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Liquidación-factura electrónica (43)."""
        return self._emit("/api/v1/dte/liquidacion-factura/emit/", body, idempotency_key)

    def emit_exportacion(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Factura de exportación electrónica (110)."""
        return self._emit("/api/v1/dte/exportacion/emit/", body, idempotency_key)

    def emit_nota_debito_exportacion(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Nota de débito de exportación (111)."""
        return self._emit("/api/v1/dte/nota-debito-exportacion/emit/", body, idempotency_key)

    def emit_nota_credito_exportacion(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Nota de crédito de exportación (112)."""
        return self._emit("/api/v1/dte/nota-credito-exportacion/emit/", body, idempotency_key)

    def emit_guia_despacho(self, body: Mapping[str, Any], idempotency_key: Optional[str] = None) -> JSON:
        """Guía de despacho electrónica (52)."""
        return self._emit("/api/v1/dte/guia-despacho/emit/", body, idempotency_key)

    def void_guia_despacho(self, dte_id: str, reason: str) -> JSON:
        """Anula una guía de despacho (Res. Ex. SII 144). Repetir la llamada devuelve la misma anulación."""
        return self.request(
            "POST", f"/api/v1/dte/guia-despacho/{dte_id}/void/",
            json_body={"reason": reason}, retry_unsafe=True,
        )

    # ------------------------------------------------------------ Documentos

    def get_document(self, dte_id: str) -> DocumentStatus:
        """Estado vigente de un documento (cualquier tipo)."""
        return self.request("GET", f"/api/v1/dte/documents/{dte_id}/")

    def get_boleta_status(self, dte_id: str) -> JSON:
        """Estado de una boleta (39/41)."""
        return self.request("GET", f"/api/v1/dte/boleta/{dte_id}/status/")

    def get_document_xml(self, dte_id: str) -> bytes:
        """DTE firmado en XML (bytes ISO-8859-1)."""
        return self.request_raw("GET", f"/api/v1/dte/documents/{dte_id}/xml/").content

    def get_document_ted(self, dte_id: str) -> JSON:
        """Timbre electrónico (TED) como texto y bytes para el PDF417."""
        return self.request("GET", f"/api/v1/dte/documents/{dte_id}/ted/")

    def get_document_ted_png(self, dte_id: str) -> bytes:
        """PDF417 del timbre como imagen PNG lista para imprimir."""
        return self.request_raw("GET", f"/api/v1/dte/documents/{dte_id}/ted.png").content

    def get_boleta_pdf(self, dte_id: str, paper_width: int = 80) -> bytes:
        """PDF térmico de una boleta (``paper_width`` 58 u 80 mm)."""
        return self.request_raw(
            "GET", f"/api/v1/dte/boleta/{dte_id}/pdf/", params={"paper_width": paper_width}
        ).content

    def get_b2b_pdf(self, dte_id: str) -> bytes:
        """PDF carta de factura, nota, factura de compra o guía de despacho."""
        return self.request_raw("GET", f"/api/v1/dte/b2b/{dte_id}/pdf/").content

    def list_documents(self, **filters: Any) -> JSON:
        """Una página del listado de documentos emitidos.

        Filtros: ``period`` (AAAA-MM), ``from_`` / ``to`` (fechas; ``from`` es palabra
        reservada de Python, usa ``from_``), ``document_type``, ``status``, ``branch_id``,
        ``folio_from``, ``folio_to``, ``updated_after``, ``limit`` (1-500), ``cursor``.
        """
        return self.request("GET", "/api/v1/dte/documents/", params=self._doc_filters(filters))

    def iter_documents(self, **filters: Any) -> Iterator[Document]:
        """Recorre TODOS los documentos que cumplen los filtros, página por página (cursor)."""
        params = dict(filters)
        while True:
            page = self.list_documents(**params)
            for doc in page.get("documents", []):
                yield doc
            cursor = page.get("next_cursor")
            if not page.get("has_more") or not cursor:
                return
            params["cursor"] = cursor

    def summarize_documents(self, **filters: Any) -> JSON:
        """Totales del período por tipo, estado y sucursal (``period`` o ``from_``+``to`` obligatorios)."""
        return self.request("GET", "/api/v1/dte/documents/summary/", params=self._doc_filters(filters))

    def export_documents(self, desde: str, hasta: str, tipo: Optional[int] = None,
                         branch_id: Optional[str] = None) -> bytes:
        """ZIP con los XML firmados del período (custodia legal, máx. 92 días)."""
        return self.request_raw(
            "GET", "/api/v1/dte/documents/export/",
            params={"desde": desde, "hasta": hasta, "tipo": tipo, "branch_id": branch_id},
        ).content

    @staticmethod
    def _doc_filters(filters: Mapping[str, Any]) -> Dict[str, Any]:
        params = dict(filters)
        if "from_" in params:
            params["from"] = params.pop("from_")
        return params

    # ------------------------------------------- Verificar ante el SII y folios

    def verify_document(self, **fields: Any) -> JSON:
        """Pregunta al SII por un documento (propio o de un tercero).

        Entrega ``document_type``, ``folio``, ``issuer_rut``, ``receptor_rut``, ``issue_date`` y
        ``amount_total``, o bien ``xml``. No sirve para boletas (39/41).
        """
        return self.request("POST", "/api/v1/dte/verify/", json_body=fields, retry_unsafe=True)

    def verify_cesion(self, document_type: int, folio: int, issuer_rut: Optional[str] = None) -> JSON:
        """Estado de cesión (factoring) de una factura 33 o 34 en el Registro de Cesiones del SII."""
        body: Dict[str, Any] = {"document_type": document_type, "folio": folio}
        if issuer_rut:
            body["issuer_rut"] = issuer_rut
        return self.request("POST", "/api/v1/dte/verify/cesion/", json_body=body, retry_unsafe=True)

    def annul_folios(self, document_type: int, folio_start: int, reason: str,
                     folio_end: Optional[int] = None, idempotency_key: Optional[str] = None) -> JSON:
        """Pide anular en el SII un rango de folios propios que no se usarán (la API responde 202)."""
        body: Dict[str, Any] = {"document_type": document_type, "folio_start": folio_start, "reason": reason}
        if folio_end is not None:
            body["folio_end"] = folio_end
        return self._emit("/api/v1/dte/folios/annul/", body, idempotency_key)

    def list_folio_annulments(self, status: Optional[str] = None, document_type: Optional[int] = None,
                              limit: Optional[int] = None) -> JSON:
        return self.request("GET", "/api/v1/dte/folios/annul/",
                            params={"status": status, "document_type": document_type, "limit": limit})

    def get_folio_annulment(self, annulment_id: str) -> JSON:
        return self.request("GET", f"/api/v1/dte/folios/annul/{annulment_id}/")

    # ------------------------------------------------- RCV y bandeja de recibidos

    def get_rcv_summary(self, period: str, operation: str, state: Optional[str] = None) -> JSON:
        """Totales oficiales del RCV del mes. ``operation``: ``purchases`` o ``sales``."""
        return self.request("GET", "/api/v1/dte/rcv/summary/",
                            params={"period": period, "operation": operation, "state": state})

    def get_vat_estimate(self, period: str, carryover: Optional[int] = None, ppm_rate: Optional[str] = None,
                         common_use_factor: Optional[str] = None) -> JSON:
        """Estimación del IVA a pagar en el F29 del mes."""
        return self.request("GET", "/api/v1/dte/rcv/vat-estimate/", params={
            "period": period, "carryover": carryover, "ppm_rate": ppm_rate,
            "common_use_factor": common_use_factor})

    def list_rcv_documents(self, period: str, operation: str, document_type: Optional[int] = None) -> JSON:
        """Documentos del RCV del mes, uno por uno (sin boletas)."""
        return self.request("GET", "/api/v1/dte/rcv/documents/", params={
            "period": period, "operation": operation, "document_type": document_type})

    def list_inbox(self, status: Optional[str] = None, period: Optional[str] = None) -> JSON:
        """Facturas recibidas con su plazo para aceptarlas o reclamarlas (8 días)."""
        return self.request("GET", "/api/v1/dte/inbox/", params={"status": status, "period": period})

    def accept_invoices(self, documents: Sequence[Mapping[str, Any]]) -> JSON:
        """Acepta facturas recibidas ante el SII. Cada una: ``supplier_rut``, ``document_type``, ``folio``."""
        return self.request("POST", "/api/v1/dte/inbox/actions/",
                            json_body={"action": "accept", "documents": list(documents)})

    def claim_invoices(self, documents: Sequence[Mapping[str, Any]], claim_reason: str) -> JSON:
        """Reclama facturas recibidas ante el SII. ``claim_reason``: ``RCD``, ``RFP`` o ``RFT``."""
        return self.request("POST", "/api/v1/dte/inbox/actions/", json_body={
            "action": "claim", "claim_reason": claim_reason, "documents": list(documents)})

    # -------------------------------------------------------------- Webhooks

    def list_webhooks(self) -> JSON:
        return self.request("GET", "/api/v1/dte/webhooks/")

    def list_webhook_event_types(self) -> JSON:
        return self.request("GET", "/api/v1/dte/webhooks/event-types/")

    def create_webhook(self, url: str, event_types: Optional[Sequence[str]] = None,
                       description: Optional[str] = None) -> JSON:
        """Registra un endpoint. La respuesta trae ``webhook.secret`` UNA sola vez: guárdalo."""
        body: Dict[str, Any] = {"url": url}
        if event_types is not None:
            body["event_types"] = list(event_types)
        if description is not None:
            body["description"] = description
        return self.request("POST", "/api/v1/dte/webhooks/", json_body=body)

    def get_webhook(self, webhook_id: str) -> JSON:
        return self.request("GET", f"/api/v1/dte/webhooks/{webhook_id}/")

    def update_webhook(self, webhook_id: str, **fields: Any) -> JSON:
        return self.request("PATCH", f"/api/v1/dte/webhooks/{webhook_id}/", json_body=fields)

    def delete_webhook(self, webhook_id: str) -> JSON:
        return self.request("DELETE", f"/api/v1/dte/webhooks/{webhook_id}/")

    def rotate_webhook_secret(self, webhook_id: str) -> JSON:
        return self.request("POST", f"/api/v1/dte/webhooks/{webhook_id}/rotate-secret/")

    def test_webhook(self, webhook_id: str) -> JSON:
        return self.request("POST", f"/api/v1/dte/webhooks/{webhook_id}/test/")

    def list_webhook_deliveries(self, webhook_id: str, status: Optional[str] = None,
                                limit: Optional[int] = None, include_payload: Optional[bool] = None) -> JSON:
        return self.request("GET", f"/api/v1/dte/webhooks/{webhook_id}/deliveries/", params={
            "status": status, "limit": limit, "include_payload": include_payload})

    def retry_webhook_delivery(self, webhook_id: str, delivery_id: str) -> JSON:
        return self.request("POST", f"/api/v1/dte/webhooks/{webhook_id}/deliveries/{delivery_id}/retry/")

    def recover_webhook(self, webhook_id: str, since: str) -> JSON:
        """Reenvía todas las entregas fallidas desde ``since`` (fecha-hora ISO 8601)."""
        return self.request("POST", f"/api/v1/dte/webhooks/{webhook_id}/recover/", json_body={"since": since})
