/** Errores del SDK. Todos heredan de SharkposError. */

export class SharkposError extends Error {
  /**
   * @param {string} message qué pasó, en español
   * @param {{code?: string, solution?: string, status?: number, body?: object, cause?: unknown}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code ?? "SHARKPOS_ERROR";
    this.solution = opts.solution;
    this.status = opts.status;
    this.body = opts.body;
  }
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
  constructor(message, opts = {}) {
    super(message, opts);
    /** Segundos a esperar según Retry-After, si la API los dio. */
    this.retryAfter = opts.retryAfter;
  }
}

/** Construye la excepción adecuada a partir de una respuesta de error. */
export function errorForStatus(status, body, retryAfter) {
  const b = body && typeof body === "object" ? body : {};
  const message = b.message || `La API respondió con error HTTP ${status}.`;
  const opts = { code: b.code || `HTTP_${status}`, solution: b.solution, status, body: b };
  if (status === 401) return new AuthenticationError(message, opts);
  if (status === 402 || status === 403) return new PermissionDeniedError(message, opts);
  if (status === 404) return new NotFoundError(message, opts);
  if (status === 409) return new ConflictError(message, opts);
  if (status === 429) return new RateLimitError(message, { ...opts, retryAfter });
  if (status >= 500) return new ServerError(message, opts);
  return new ValidationError(message, opts);
}
