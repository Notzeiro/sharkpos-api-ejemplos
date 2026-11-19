"""Tipos de ayuda para editores (los métodos devuelven los dict JSON de la API)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, TypedDict

JSON = Dict[str, Any]


class BoletaItem(TypedDict, total=False):
    name: str
    description: str
    qty: float
    price: float
    amount: int
    unit: str
    ind_exe: int


class BoletaRequest(TypedDict, total=False):
    document_type: int  # 39 o 41
    amount_total: int
    items: List[BoletaItem]
    medio_pago: int
    fecha_emision: str
    receptor_rut: str
    receptor_name: str
    receptor_email: str
    branch_id: str


class Links(TypedDict, total=False):
    status: str
    pdf: str
    xml: str
    ted: str
    ted_png: str


class EmissionResponse(TypedDict, total=False):
    status: str  # "success"
    dte_id: str
    folio: int
    document_type: int
    dte_status: str
    idempotency_replayed: bool
    links: Links
    pdf_url: str
    public_url: Optional[str]


class Document(TypedDict, total=False):
    id: str
    document_type: int
    folio: int
    issue_date: str
    status: str
    dte_status: str
    receptor_rut: str
    receptor_name: str
    amounts: Dict[str, Any]
