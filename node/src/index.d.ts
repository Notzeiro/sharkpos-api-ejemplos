export const PRODUCTION_URL: string;
export const SANDBOX_URL: string;
export const VERSION: string;

export type Json = Record<string, any>;

export interface BoletaItem {
  name: string;
  description?: string;
  qty?: number;
  price: number;
  amount?: number;
  unit?: string;
  /** 1 exento, 2 no facturable, 6 según tabla SII. */
  ind_exe?: 1 | 2 | 6;
}

export interface BoletaRequest {
  document_type?: 39 | 41;
  amount_total: number;
  items: BoletaItem[];
  medio_pago?: 1 | 2 | 3 | 4 | 5;
  fecha_emision?: string;
  receptor_rut?: string;
  receptor_name?: string;
  receptor_email?: string;
  branch_id?: string;
  [campo: string]: unknown;
}

/** Cuerpo de factura, nota, guía, exportación, etc.: ver docs/openapi.yaml. */
export type DocumentRequest = Record<string, unknown>;

export interface Links {
  status?: string;
  pdf?: string;
  xml?: string;
  ted?: string;
  ted_png?: string;
}

export interface EmissionResponse {
  status: "success" | "processing";
  dte_id: string;
  folio: number;
  document_type: number;
  dte_status: string;
  idempotency_replayed?: boolean;
  branch_id?: string | null;
  links?: Links;
  pdf_url?: string;
  public_url?: string | null;
  [campo: string]: unknown;
}

export interface DocumentStatus {
  status: "ok";
  dte_id: string;
  document_type: number;
  folio: number;
  /** Estado interno: SIGNED, SENT_PENDING, ACCEPTED, REJECTED_SII... */
  dte_status: string;
  public_status: DocumentStatusName;
  message?: string;
  solution?: string;
  is_final?: boolean;
  requires_attention?: boolean;
  track_id?: string | null;
  [campo: string]: unknown;
}

export type DocumentStatusName =
  | "preparing" | "queued" | "sent" | "accepted" | "accepted_with_repair"
  | "rejected" | "review_required" | "failed" | "annulled";

export interface DocumentListItem {
  id: string;
  document_type: number;
  folio: number;
  issue_date: string;
  created_at: string;
  updated_at: string;
  status: DocumentStatusName;
  dte_status: string;
  receptor_rut?: string;
  receptor_name?: string;
  amounts?: Json;
  [campo: string]: unknown;
}

export interface DocumentList {
  status: "ok";
  order: string;
  documents: DocumentListItem[];
  has_more: boolean;
  next_cursor: string | null;
  next: string | null;
}

export interface DocumentFilters {
  period?: string;
  from?: string;
  to?: string;
  document_type?: number | number[];
  status?: string | string[];
  branch_id?: string;
  folio_from?: number;
  folio_to?: number;
  updated_after?: string;
  limit?: number;
  cursor?: string;
}

export interface InboxDocument {
  supplier_rut: string;
  document_type: 33 | 34 | 43;
  folio: number;
}

export interface ClientOptions {
  apiKey?: string;
  sandbox?: boolean;
  baseUrl?: string;
  /** Segundos por intento (30). */
  timeout?: number;
  /** Reintentos ante 429, 5xx o falla de red (3). */
  maxRetries?: number;
  /** Espera base en segundos (0.5). */
  backoff?: number;
  sleep?: (seconds: number) => Promise<void>;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  params?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
  retryUnsafe?: boolean;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  buffer: Buffer;
}

export class SharkposClient {
  constructor(options?: ClientOptions);
  readonly baseUrl: string;

  request<T = Json>(method: string, path: string, options?: RequestOptions): Promise<T>;
  requestRaw(method: string, path: string, options?: RequestOptions): Promise<RawResponse>;

  emitBoleta(body: BoletaRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitFactura(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitFacturaExenta(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitNotaCredito(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitNotaDebito(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitFacturaCompra(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitLiquidacionFactura(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitExportacion(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitNotaDebitoExportacion(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitNotaCreditoExportacion(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  emitGuiaDespacho(body: DocumentRequest, idempotencyKey?: string): Promise<EmissionResponse>;
  voidGuiaDespacho(dteId: string, reason: string): Promise<Json>;

  getDocument(dteId: string): Promise<DocumentStatus>;
  getBoletaStatus(dteId: string): Promise<Json>;
  getDocumentTed(dteId: string): Promise<Json>;
  getDocumentXml(dteId: string): Promise<Buffer>;
  getDocumentTedPng(dteId: string): Promise<Buffer>;
  getBoletaPdf(dteId: string, paperWidth?: 58 | 80): Promise<Buffer>;
  getB2bPdf(dteId: string): Promise<Buffer>;
  listDocuments(filters?: DocumentFilters): Promise<DocumentList>;
  iterDocuments(filters?: DocumentFilters): AsyncGenerator<DocumentListItem, void, undefined>;
  summarizeDocuments(filters?: DocumentFilters): Promise<Json>;
  exportDocuments(args: { desde: string; hasta: string; tipo?: number; branch_id?: string }): Promise<Buffer>;

  verifyDocument(fields: Json): Promise<Json>;
  verifyCesion(args: { document_type: 33 | 34; folio: number; issuer_rut?: string }): Promise<Json>;
  annulFolios(
    args: { document_type: number; folio_start: number; folio_end?: number; reason: string },
    idempotencyKey?: string,
  ): Promise<Json>;
  listFolioAnnulments(filters?: { status?: string; document_type?: number; limit?: number }): Promise<Json>;
  getFolioAnnulment(id: string): Promise<Json>;

  getRcvSummary(args: { period: string; operation: "purchases" | "sales"; state?: string }): Promise<Json>;
  getVatEstimate(args: { period: string; carryover?: number; ppm_rate?: string; common_use_factor?: string }): Promise<Json>;
  listRcvDocuments(args: { period: string; operation: "purchases" | "sales"; document_type?: number }): Promise<Json>;
  listInbox(filters?: { status?: string; period?: string }): Promise<Json>;
  acceptInvoices(documents: InboxDocument[]): Promise<Json>;
  claimInvoices(documents: InboxDocument[], claimReason: "RCD" | "RFP" | "RFT"): Promise<Json>;

  listWebhooks(): Promise<Json>;
  listWebhookEventTypes(): Promise<Json>;
  createWebhook(args: { url: string; event_types?: string[]; description?: string }): Promise<Json>;
  getWebhook(id: string): Promise<Json>;
  updateWebhook(id: string, fields: Json): Promise<Json>;
  deleteWebhook(id: string): Promise<Json>;
  rotateWebhookSecret(id: string): Promise<Json>;
  testWebhook(id: string): Promise<Json>;
  listWebhookDeliveries(id: string, filters?: { status?: string; limit?: number; include_payload?: boolean }): Promise<Json>;
  retryWebhookDelivery(id: string, deliveryId: string): Promise<Json>;
  recoverWebhook(id: string, since: string): Promise<Json>;
}

export class SharkposError extends Error {
  constructor(message: string, opts?: { code?: string; solution?: string; status?: number; body?: Json; cause?: unknown });
  code: string;
  solution?: string;
  status?: number;
  body?: Json;
}
export class AuthenticationError extends SharkposError {}
export class PermissionDeniedError extends SharkposError {}
export class NotFoundError extends SharkposError {}
export class ConflictError extends SharkposError {}
export class ValidationError extends SharkposError {}
export class ServerError extends SharkposError {}
export class ConnectionFailedError extends SharkposError {}
export class WebhookSignatureError extends SharkposError {}
export class RateLimitError extends SharkposError {
  retryAfter?: number;
}

export function verifyWebhook(
  payload: string | Buffer,
  headers: Record<string, string | string[] | undefined> | Headers,
  secret: string,
  options?: { tolerance?: number; now?: number },
): Json;
export function signWebhook(secret: string, id: string, timestamp: string | number, payload: string | Buffer): string;
