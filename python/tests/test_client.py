"""Pruebas contra un servidor HTTP simulado local. No toca la red real."""

import base64
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sharkpos import (  # noqa: E402
    AuthenticationError, ConflictError, ConnectionFailedError, RateLimitError, ServerError,
    SharkposClient, SharkposError, ValidationError, WebhookSignatureError, verify_webhook,
)
from sharkpos.webhooks import sign  # noqa: E402


class Mock:
    """Servidor simulado: cola de respuestas por (método, ruta) y registro de solicitudes."""

    def __init__(self):
        self.requests = []
        self.queue = {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                outer.requests.append({
                    "method": self.command, "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": json.loads(body) if body else None,
                })
                key = (self.command, self.path.split("?")[0])
                items = outer.queue.get(key, [])
                status, payload, headers = items.pop(0) if len(items) > 1 else (items[0] if items else (404, {"status": "error", "code": "NOT_FOUND", "message": "x"}, {}))
                if payload == "HANGUP":
                    self.connection.close()
                    return
                raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_PATCH = do_DELETE = _handle

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def on(self, method, path, status, payload, headers=None):
        self.queue.setdefault((method, path), []).append((status, payload, headers or {}))

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.mock = Mock()
        self.sleeps = []
        self.client = SharkposClient("test-key", base_url=self.mock.url, sleep=self.sleeps.append, backoff=1.0)

    def tearDown(self):
        self.mock.close()

    def test_requires_api_key(self):
        os.environ.pop("SHARKPOS_API_KEY", None)
        with self.assertRaises(SharkposError) as ctx:
            SharkposClient(base_url=self.mock.url)
        self.assertEqual(ctx.exception.code, "API_KEY_MISSING")

    def test_emit_sends_bearer_and_auto_uuid_key(self):
        self.mock.on("POST", "/api/v1/dte/boleta/emit/", 201, {"status": "success", "dte_id": "abc", "folio": 7})
        out = self.client.emit_boleta({"amount_total": 100, "items": [{"name": "Ñandú", "price": 100}]})
        self.assertEqual(out["folio"], 7)
        req = self.mock.requests[0]
        self.assertEqual(req["headers"]["authorization"], "Bearer test-key")
        self.assertEqual(len(req["headers"]["idempotency-key"]), 36)
        self.assertEqual(req["body"]["items"][0]["name"], "Ñandú")

    def test_retries_5xx_with_same_key_and_backoff(self):
        path = "/api/v1/dte/factura/emit/"
        self.mock.on("POST", path, 503, {"status": "error", "code": "SII_UNAVAILABLE", "message": "caído"})
        self.mock.on("POST", path, 503, {"status": "error", "code": "SII_UNAVAILABLE", "message": "caído"})
        self.mock.on("POST", path, 201, {"status": "success", "folio": 1})
        out = self.client.emit_factura({"x": 1}, idempotency_key="venta-884")
        self.assertEqual(out["folio"], 1)
        keys = {r["headers"]["idempotency-key"] for r in self.mock.requests}
        self.assertEqual(keys, {"venta-884"})
        self.assertEqual(len(self.mock.requests), 3)
        self.assertEqual(len(self.sleeps), 2)
        self.assertGreaterEqual(self.sleeps[1], self.sleeps[0])  # backoff exponencial

    def test_respects_retry_after_on_429(self):
        path = "/api/v1/dte/boleta/emit/"
        self.mock.on("POST", path, 429, {"status": "error", "code": "RATE_LIMIT_EXCEEDED", "message": "lento"},
                     {"Retry-After": "7"})
        self.mock.on("POST", path, 201, {"status": "success"})
        self.client.emit_boleta({})
        self.assertEqual(self.sleeps, [7.0])

    def test_gives_up_after_max_retries(self):
        path = "/api/v1/dte/boleta/emit/"
        self.mock.on("POST", path, 500, {"status": "error", "code": "INTERNAL_ERROR", "message": "falla"})
        with self.assertRaises(ServerError):
            self.client.emit_boleta({})
        self.assertEqual(len(self.mock.requests), 4)  # 1 + 3 reintentos

    def test_429_exposes_retry_after(self):
        c = SharkposClient("k", base_url=self.mock.url, max_retries=0, sleep=lambda s: None)
        self.mock.on("GET", "/api/v1/dte/documents/x/", 429, {"code": "RATE_LIMIT_EXCEEDED", "message": "m"},
                     {"Retry-After": "3"})
        with self.assertRaises(RateLimitError) as ctx:
            c.get_document("x")
        self.assertEqual(ctx.exception.retry_after, 3.0)

    def test_4xx_not_retried_and_error_fields(self):
        self.mock.on("POST", "/api/v1/dte/boleta/emit/", 400,
                     {"status": "error", "code": "INVALID_REQUEST", "message": "Monto inválido", "solution": "Revisa amount_total"})
        with self.assertRaises(ValidationError) as ctx:
            self.client.emit_boleta({})
        e = ctx.exception
        self.assertEqual((e.code, e.message, e.solution, e.status_code),
                         ("INVALID_REQUEST", "Monto inválido", "Revisa amount_total", 400))
        self.assertEqual(len(self.mock.requests), 1)
        self.assertIn("Solución", str(e))

    def test_401_and_409(self):
        self.mock.on("GET", "/api/v1/dte/documents/a/", 401, {"code": "INVALID_API_KEY", "message": "m"})
        with self.assertRaises(AuthenticationError):
            self.client.get_document("a")
        self.mock.on("POST", "/api/v1/dte/factura/emit/", 409, {"code": "FOLIOS_EXHAUSTED", "message": "m"})
        with self.assertRaises(ConflictError) as ctx:
            self.client.emit_factura({})
        self.assertEqual(ctx.exception.code, "FOLIOS_EXHAUSTED")

    def test_202_processing_is_returned_not_raised(self):
        self.mock.on("POST", "/api/v1/dte/boleta/emit/", 202, {"status": "processing", "dte_id": "z"})
        self.assertEqual(self.client.emit_boleta({})["status"], "processing")

    def test_network_failure_retries_then_raises(self):
        self.mock.on("POST", "/api/v1/dte/boleta/emit/", 200, "HANGUP")
        c = SharkposClient("k", base_url=self.mock.url, max_retries=1, sleep=lambda s: None)
        with self.assertRaises(ConnectionFailedError):
            c.emit_boleta({})
        self.assertEqual(len(self.mock.requests), 2)

    def test_connection_refused(self):
        c = SharkposClient("k", base_url="http://127.0.0.1:1", max_retries=0)
        with self.assertRaises(ConnectionFailedError):
            c.get_document("x")

    def test_post_without_key_not_retried_on_5xx(self):
        self.mock.on("POST", "/api/v1/dte/webhooks/", 500, {"code": "INTERNAL_ERROR", "message": "m"})
        with self.assertRaises(ServerError):
            self.client.create_webhook("https://ejemplo.cl/hook")
        self.assertEqual(len(self.mock.requests), 1)

    def test_pagination_iterator_follows_cursor(self):
        p = "/api/v1/dte/documents/"
        self.mock.on("GET", p, 200, {"documents": [{"id": 1}, {"id": 2}], "has_more": True, "next_cursor": "c1"})
        self.mock.on("GET", p, 200, {"documents": [{"id": 3}], "has_more": False, "next_cursor": None})
        ids = [d["id"] for d in self.client.iter_documents(period="2026-10", document_type=[33, 61], from_="2026-10-01")]
        self.assertEqual(ids, [1, 2, 3])
        first, second = self.mock.requests
        self.assertIn("period=2026-10", first["path"])
        self.assertIn("document_type=33&document_type=61", first["path"])
        self.assertIn("from=2026-10-01", first["path"])
        self.assertIn("cursor=c1", second["path"])
        self.assertNotIn("cursor", first["path"])

    def test_binary_downloads(self):
        self.mock.on("GET", "/api/v1/dte/boleta/u1/pdf/", 200, b"%PDF-1.4 fake")
        self.assertEqual(self.client.get_boleta_pdf("u1", paper_width=58), b"%PDF-1.4 fake")
        self.assertIn("paper_width=58", self.mock.requests[0]["path"])
        self.mock.on("GET", "/api/v1/dte/documents/u1/xml/", 200, "<DTE/>".encode("latin-1"))
        self.assertEqual(self.client.get_document_xml("u1"), b"<DTE/>")

    def test_verify_and_cesion_and_annul(self):
        self.mock.on("POST", "/api/v1/dte/verify/", 200, {"status": "ok", "verification": {"result": "accepted"}})
        out = self.client.verify_document(document_type=33, folio=5, issuer_rut="76192083-9")
        self.assertEqual(out["verification"]["result"], "accepted")
        self.assertEqual(self.mock.requests[-1]["body"]["folio"], 5)
        self.mock.on("POST", "/api/v1/dte/verify/cesion/", 200, {"status": "ok", "cesion": {"ceded": False}})
        self.assertFalse(self.client.verify_cesion(33, 5)["cesion"]["ceded"])
        self.mock.on("POST", "/api/v1/dte/folios/annul/", 202, {"status": "ok", "annulment": {"status": "PENDING"}})
        self.client.annul_folios(33, 40, "Folios de prueba", folio_end=45)
        r = self.mock.requests[-1]
        self.assertEqual(r["body"], {"document_type": 33, "folio_start": 40, "reason": "Folios de prueba", "folio_end": 45})
        self.assertTrue(r["headers"]["idempotency-key"])

    def test_inbox_actions(self):
        self.mock.on("POST", "/api/v1/dte/inbox/actions/", 200, {"status": "ok", "results": []})
        docs = [{"supplier_rut": "76086428-5", "document_type": 33, "folio": 10}]
        self.client.accept_invoices(docs)
        self.assertEqual(self.mock.requests[-1]["body"], {"action": "accept", "documents": docs})
        self.client.claim_invoices(docs, "RCD")
        self.assertEqual(self.mock.requests[-1]["body"]["claim_reason"], "RCD")

    def test_rcv_and_webhooks_paths(self):
        self.mock.on("GET", "/api/v1/dte/rcv/summary/", 200, {"status": "ok"})
        self.client.get_rcv_summary("2026-09", "sales")
        self.assertIn("operation=sales", self.mock.requests[-1]["path"])
        self.mock.on("POST", "/api/v1/dte/webhooks/", 201, {"webhook": {"secret": "whsec_x"}})
        self.client.create_webhook("https://ejemplo.cl/h", ["dte.accepted"])
        self.assertEqual(self.mock.requests[-1]["body"]["event_types"], ["dte.accepted"])
        self.mock.on("POST", "/api/v1/dte/webhooks/w1/recover/", 202, {"status": "ok"})
        self.client.recover_webhook("w1", "2026-09-28T00:00:00Z")
        self.assertEqual(self.mock.requests[-1]["body"], {"since": "2026-09-28T00:00:00Z"})


class WebhookTests(unittest.TestCase):
    SECRET = "whsec_" + base64.b64encode(b"super-secreto-de-prueba").decode()

    def _signed(self, payload, ts=None, msg_id="evt-1"):
        ts = ts or int(time.time())
        return {"webhook-id": msg_id, "webhook-timestamp": str(ts),
                "webhook-signature": sign(self.SECRET, msg_id, ts, payload)}

    def test_valid_signature(self):
        payload = json.dumps({"type": "dte.accepted", "data": {"folio": 3}})
        event = verify_webhook(payload.encode(), self._signed(payload), self.SECRET)
        self.assertEqual(event["type"], "dte.accepted")

    def test_headers_case_insensitive_and_multiple_signatures(self):
        payload = '{"a":1}'
        h = self._signed(payload)
        h = {"Webhook-Id": h["webhook-id"], "Webhook-Timestamp": h["webhook-timestamp"],
             "Webhook-Signature": "v1,AAAA " + h["webhook-signature"]}
        self.assertEqual(verify_webhook(payload, h, self.SECRET), {"a": 1})

    def test_tampered_body_rejected(self):
        h = self._signed('{"a":1}')
        with self.assertRaises(WebhookSignatureError) as ctx:
            verify_webhook('{"a":2}', h, self.SECRET)
        self.assertEqual(ctx.exception.code, "WEBHOOK_SIGNATURE_INVALID")

    def test_old_timestamp_rejected(self):
        h = self._signed('{"a":1}', ts=int(time.time()) - 3600)
        with self.assertRaises(WebhookSignatureError) as ctx:
            verify_webhook('{"a":1}', h, self.SECRET)
        self.assertEqual(ctx.exception.code, "WEBHOOK_TIMESTAMP_EXPIRED")

    def test_missing_headers(self):
        with self.assertRaises(WebhookSignatureError):
            verify_webhook("{}", {}, self.SECRET)


if __name__ == "__main__":
    unittest.main()
