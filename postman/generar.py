#!/usr/bin/env python3
"""Genera la colección Postman de SharkPOS API a partir del openapi.yaml.

Uso:
    python postman/generar.py [--openapi RUTA_O_URL] [--salida ARCHIVO.json]

Por defecto lee https://api.sharkpos.cl/docs/openapi.yaml (la fuente de verdad pública) y, si no hay red,
busca el contrato junto a este repositorio. Requiere PyYAML (pip install pyyaml).
La salida es determinista: misma entrada, mismo archivo.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
import urllib.request
from pathlib import Path

import yaml

URL_PUBLICA = "https://api.sharkpos.cl/docs/openapi.yaml"
LOCAL = Path(__file__).resolve().parent.parent.parent / "sharkpos api" / "engine-extras" / "docs" / "openapi.yaml"
METODOS = ("get", "post", "put", "patch", "delete")
SCHEMA_URL = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"


def cargar(origen: str) -> dict:
    if origen.startswith(("http://", "https://")):
        with urllib.request.urlopen(origen, timeout=30) as r:  # noqa: S310 (URL pasada por el usuario)
            return yaml.safe_load(r.read().decode("utf-8"))
    return yaml.safe_load(Path(origen).read_text(encoding="utf-8"))


class Resolutor:
    def __init__(self, spec: dict) -> None:
        self.spec = spec

    def ref(self, nodo):
        """Resuelve $ref (solo referencias internas '#/...')."""
        vistos = 0
        while isinstance(nodo, dict) and "$ref" in nodo and vistos < 20:
            ruta = nodo["$ref"]
            if not ruta.startswith("#/"):
                return {}
            actual = self.spec
            for parte in ruta[2:].split("/"):
                actual = actual[parte]
            nodo = actual
            vistos += 1
        return nodo

    def ejemplo(self, esquema, profundidad: int = 0):
        """Valor de ejemplo para un esquema: example > default > enum > por tipo."""
        esquema = self.ref(esquema)
        if not isinstance(esquema, dict) or profundidad > 5:
            return None
        if "example" in esquema:
            return copy.deepcopy(esquema["example"])
        if "const" in esquema:
            return esquema["const"]
        if "default" in esquema:
            return esquema["default"]
        if esquema.get("enum"):
            return esquema["enum"][0]
        if "allOf" in esquema:
            salida: dict = {}
            for parte in esquema["allOf"]:
                v = self.ejemplo(parte, profundidad + 1)
                if isinstance(v, dict):
                    salida.update(v)
            return salida
        for clave in ("oneOf", "anyOf"):
            if esquema.get(clave):
                return self.ejemplo(esquema[clave][0], profundidad + 1)
        tipo = esquema.get("type")
        if isinstance(tipo, list):
            tipo = next((t for t in tipo if t != "null"), None)
        if tipo == "object" or "properties" in esquema:
            props = esquema.get("properties", {})
            return {k: self.ejemplo(v, profundidad + 1) for k, v in props.items()}
        if tipo == "array":
            return [self.ejemplo(esquema.get("items", {}), profundidad + 1)]
        if tipo == "integer":
            return esquema.get("minimum", 1) if esquema.get("minimum") else 1
        if tipo == "number":
            return 1
        if tipo == "boolean":
            return False
        if tipo == "string":
            formato = esquema.get("format")
            return {"date": "2026-10-01", "date-time": "2026-10-01T12:00:00Z", "uuid": "00000000-0000-4000-8000-000000000000",
                    "email": "cliente@ejemplo.cl", "uri": "https://ejemplo.cl/webhook"}.get(formato, "texto")
        return None


def limpiar(valor):
    """Quita None de dicts (campos sin ejemplo útil) manteniendo el orden."""
    if isinstance(valor, dict):
        return {k: limpiar(v) for k, v in valor.items() if v is not None}
    if isinstance(valor, list):
        return [limpiar(v) for v in valor if v is not None]
    return valor


def construir(spec: dict) -> dict:
    res = Resolutor(spec)
    carpetas: dict[str, list] = {}
    orden_tags = [t["name"] for t in spec.get("tags", [])]

    for ruta, item in spec["paths"].items():
        comunes = item.get("parameters", [])
        for metodo in METODOS:
            op = item.get(metodo)
            if not op:
                continue
            params = [res.ref(p) for p in comunes + op.get("parameters", [])]
            partner = any("partnerKey" in s for s in op.get("security", []))

            # URL: /api/v1/dte/x/{dte_id}/ -> {{base_url}}/api/v1/dte/x/:dte_id/
            segmentos = [s for s in ruta.split("/") if s]
            segmentos = [":" + s[1:-1] if s.startswith("{") and s.endswith("}") else s for s in segmentos]
            variables = [
                {"key": p["name"], "value": str(res.ejemplo(p.get("schema", {})) or ""), "description": p.get("description", "")}
                for p in params if p.get("in") == "path"
            ]
            query = []
            for p in params:
                if p.get("in") != "query":
                    continue
                valor = res.ejemplo(p.get("schema", {})) if "example" not in p else p["example"]
                if isinstance(valor, list):
                    valor = ",".join(str(v) for v in valor)
                query.append({
                    "key": p["name"], "value": "" if valor is None else str(valor),
                    "description": p.get("description", ""), "disabled": not p.get("required", False),
                })

            cabeceras = [{"key": "Accept", "value": "application/json"}]
            for p in params:
                if p.get("in") != "header":
                    continue
                if p["name"].lower() == "idempotency-key":
                    # {{$guid}} es la variable dinámica de Postman: un UUID nuevo por envío.
                    cabeceras.append({"key": "Idempotency-Key", "value": "{{$guid}}",
                                      "description": "Usa el id de tu venta para que un reintento nunca emita dos documentos."})
                elif p["name"].lower() == "x-device-secret":
                    cabeceras.append({"key": "X-Device-Secret", "value": "{{device_secret}}"})

            peticion: dict = {
                "method": metodo.upper(),
                "header": cabeceras,
                "url": {
                    "raw": "{{base_url}}/" + "/".join(segmentos) + ("/" if ruta.endswith("/") else "")
                           + ("?" + "&".join(f"{q['key']}={q['value']}" for q in query if not q["disabled"]) if any(not q["disabled"] for q in query) else ""),
                    "host": ["{{base_url}}"],
                    "path": segmentos,
                },
                "description": "\n\n".join(x for x in (op.get("summary"), (op.get("description") or "").strip()) if x),
            }
            if query:
                peticion["url"]["query"] = query
            if variables:
                peticion["url"]["variable"] = variables
            if partner:
                peticion["auth"] = {"type": "bearer", "bearer": [{"key": "token", "value": "{{partner_key}}", "type": "string"}]}

            cuerpo = (op.get("requestBody") or {}).get("content", {}).get("application/json")
            if cuerpo:
                ejemplo = cuerpo.get("example")
                if ejemplo is None and cuerpo.get("examples"):
                    ejemplo = res.ref(next(iter(cuerpo["examples"].values()))).get("value")
                if ejemplo is None:
                    ejemplo = limpiar(res.ejemplo(cuerpo.get("schema", {})))
                cabeceras.append({"key": "Content-Type", "value": "application/json"})
                peticion["body"] = {"mode": "raw", "raw": json.dumps(ejemplo, ensure_ascii=False, indent=2),
                                    "options": {"raw": {"language": "json"}}}

            multipart = (op.get("requestBody") or {}).get("content", {}).get("multipart/form-data")
            if multipart:
                esquema = res.ref(multipart.get("schema", {}))
                campos = []
                for clave, sub in esquema.get("properties", {}).items():
                    sub = res.ref(sub)
                    if sub.get("format") == "binary":
                        campos.append({"key": clave, "type": "file", "src": []})
                    else:
                        valor = res.ejemplo(sub)
                        campos.append({"key": clave, "type": "text", "value": "" if valor is None else str(valor)})
                peticion["body"] = {"mode": "formdata", "formdata": campos}

            nombre = op.get("summary") or op.get("operationId") or f"{metodo.upper()} {ruta}"
            tag = (op.get("tags") or ["Otros"])[0]
            carpetas.setdefault(tag, []).append({"name": nombre, "request": peticion, "response": []})

    carpetas_ordenadas = sorted(carpetas, key=lambda t: (orden_tags.index(t) if t in orden_tags else 999, t))
    info = spec.get("info", {})
    return {
        "info": {
            "name": info.get("title", "SharkPOS API"),
            "description": (info.get("summary", "") + "\n\nVariables: base_url (https://sandbox.sharkpos.cl para pruebas, "
                            "https://api.sharkpos.cl en producción), api_key, y opcionalmente partner_key y device_secret. "
                            "Las solicitudes de emisión crean documentos tributarios REALES con una API key de producción."),
            "schema": SCHEMA_URL,
        },
        "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{api_key}}", "type": "string"}]},
        "variable": [
            {"key": "base_url", "value": "https://sandbox.sharkpos.cl"},
            {"key": "api_key", "value": ""},
            {"key": "partner_key", "value": ""},
            {"key": "device_secret", "value": ""},
        ],
        "item": [{"name": t, "description": next((x.get("description", "") for x in spec.get("tags", []) if x["name"] == t), ""),
                  "item": carpetas[t]} for t in carpetas_ordenadas],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--openapi", help="ruta o URL del openapi.yaml")
    ap.add_argument("--salida", default=str(Path(__file__).resolve().parent / "sharkpos-api.postman_collection.json"))
    args = ap.parse_args()

    origen = args.openapi
    if not origen:
        origen = str(LOCAL) if LOCAL.exists() else URL_PUBLICA
    spec = cargar(origen)
    coleccion = construir(spec)
    Path(args.salida).write_text(json.dumps(coleccion, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total = sum(len(c["item"]) for c in coleccion["item"])
    print(f"Colección generada: {total} solicitudes en {len(coleccion['item'])} carpetas -> {args.salida}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
