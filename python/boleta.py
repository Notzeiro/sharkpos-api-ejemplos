# Ejemplo de SharkPOS API (sandbox). Guía: https://api.sharkpos.cl/guias/boleta-electronica-python/
# Variable de entorno: SHARKPOS_API_KEY. Nunca pongas la API key en el código.

import os
import requests

BASE = "https://sandbox.sharkpos.cl/api/v1/dte"
API_KEY = os.environ["SHARKPOS_API_KEY"]

def headers(venta_id):
    return {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Idempotency-Key": venta_id,  # estable por venta, 8 a 128 caracteres
    }

boleta = {
    "document_type": 39,
    "amount_total": 16980,
    "medio_pago": 1,
    "items": [
        {"name": "Ñoquis a la boloñesa", "qty": 1, "price": 8990},
        {"name": "Café cortado", "qty": 2, "price": 3995},
    ],
}

r = requests.post(f"{BASE}/boleta/emit/", json=boleta,
                  headers=headers("venta-884"), timeout=30)
print(r.status_code, r.json())


import time

def emitir_boleta(venta_id, body, intentos=5):
    espera = 2
    for _ in range(intentos):
        try:
            r = requests.post(f"{BASE}/boleta/emit/", json=body,
                              headers=headers(venta_id), timeout=30)
        except requests.RequestException:
            time.sleep(espera); espera *= 2
            continue

        if r.status_code in (200, 201):
            return r.json()
        if r.status_code == 202 or r.status_code >= 500:
            time.sleep(espera); espera *= 2
            continue
        if r.status_code == 429:
            time.sleep(int(r.headers.get("Retry-After", espera)))
            continue

        # Otro 4xx: no reintentar, corregir la solicitud
        err = r.json()
        raise RuntimeError(f'{err.get("code")}: {err.get("message")} {err.get("solution", "")}')
    raise TimeoutError("Sin respuesta definitiva; reintenta más tarde con la misma Idempotency-Key")


def esperar_resultado(dte_id, maximo=8):
    espera = 30
    for _ in range(maximo):
        r = requests.get(f"{BASE}/documents/{dte_id}/",
                         headers={"Authorization": f"Bearer {API_KEY}"}, timeout=30)
        r.raise_for_status()
        doc = r.json()
        if doc["is_final"]:
            return doc
        time.sleep(espera)
        espera = min(espera * 2, 300)
    return doc

resultado = emitir_boleta("venta-884", boleta)
doc = esperar_resultado(resultado["dte_id"])
print(doc["public_status"], doc["message"])
