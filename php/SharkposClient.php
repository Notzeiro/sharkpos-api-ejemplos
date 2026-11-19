<?php
/**
 * Cliente simple de SharkPOS API en un solo archivo. Sin dependencias (solo la extensión cURL).
 *
 *   require 'SharkposClient.php';
 *   $c = new SharkposClient(getenv('SHARKPOS_API_KEY'), true);   // true = sandbox
 *   $doc = $c->emitirBoleta(['amount_total' => 3000, 'items' => [['name' => 'Café', 'qty' => 2, 'price' => 1500]]], 'venta-884');
 *   echo $doc['folio'];
 *
 * Idempotency-Key: pasa el id de tu venta. Si no la pasas, se genera un UUID4 que se reutiliza en los
 * reintentos de esa llamada. Reintenta 429, 5xx y fallas de red con backoff exponencial y Retry-After.
 * Con una API key de producción, emitir*() crea un documento tributario real ante el SII.
 */
class SharkposException extends RuntimeException
{
    public string $errorCode;
    public ?string $solution;
    public ?int $httpStatus;
    public array $body;

    public function __construct(string $message, string $errorCode = 'SHARKPOS_ERROR', ?string $solution = null, ?int $httpStatus = null, array $body = [])
    {
        parent::__construct($message);
        $this->errorCode = $errorCode;
        $this->solution = $solution;
        $this->httpStatus = $httpStatus;
        $this->body = $body;
    }
}

class SharkposClient
{
    public const PRODUCCION = 'https://api.sharkpos.cl';
    public const SANDBOX = 'https://sandbox.sharkpos.cl';

    private string $apiKey;
    private string $baseUrl;
    private int $timeout;
    private int $maxRetries;
    private float $backoff;

    public function __construct(?string $apiKey = null, bool $sandbox = false, ?string $baseUrl = null, int $timeout = 30, int $maxRetries = 3, float $backoff = 0.5)
    {
        $apiKey = $apiKey ?: (getenv('SHARKPOS_API_KEY') ?: '');
        if ($apiKey === '') {
            throw new SharkposException('Falta la API key. Pásala al crear el cliente o define SHARKPOS_API_KEY.', 'API_KEY_MISSING', 'Pide una llave de prueba gratis en https://api.sharkpos.cl/sandbox/');
        }
        $this->apiKey = $apiKey;
        $this->baseUrl = rtrim($baseUrl ?: ($sandbox ? self::SANDBOX : self::PRODUCCION), '/');
        $this->timeout = $timeout;
        $this->maxRetries = max(0, $maxRetries);
        $this->backoff = $backoff;
    }

    // ---------------------------------------------------------------- Emisión

    /** Boleta electrónica (39) o exenta (41). */
    public function emitirBoleta(array $body, ?string $idempotencyKey = null): array
    {
        return $this->emitir('/api/v1/dte/boleta/emit/', $body, $idempotencyKey);
    }

    /** Factura electrónica (33). */
    public function emitirFactura(array $body, ?string $idempotencyKey = null): array
    {
        return $this->emitir('/api/v1/dte/factura/emit/', $body, $idempotencyKey);
    }

    /** Nota de crédito electrónica (61). */
    public function emitirNotaCredito(array $body, ?string $idempotencyKey = null): array
    {
        return $this->emitir('/api/v1/dte/nota-credito/emit/', $body, $idempotencyKey);
    }

    // -------------------------------------------------------------- Consultas

    /** Estado vigente de un documento (cualquier tipo). */
    public function estado(string $dteId): array
    {
        return $this->json('GET', "/api/v1/dte/documents/$dteId/");
    }

    /** PDF térmico de una boleta como string binario (58 u 80 mm). */
    public function pdfBoleta(string $dteId, int $anchoPapel = 80): string
    {
        return $this->solicitar('GET', "/api/v1/dte/boleta/$dteId/pdf/", ['paper_width' => $anchoPapel])['body'];
    }

    /** PDF carta de factura, nota o guía. */
    public function pdfFactura(string $dteId): string
    {
        return $this->solicitar('GET', "/api/v1/dte/b2b/$dteId/pdf/")['body'];
    }

    /** Una página del listado. Devuelve ['documents' => [...], 'has_more' => bool, 'next_cursor' => ?string]. */
    public function listar(array $filtros = []): array
    {
        return $this->json('GET', '/api/v1/dte/documents/', $filtros);
    }

    /** Generador que recorre todas las páginas (cursor). */
    public function todos(array $filtros = []): Generator
    {
        while (true) {
            $pagina = $this->listar($filtros);
            foreach ($pagina['documents'] ?? [] as $doc) {
                yield $doc;
            }
            if (empty($pagina['has_more']) || empty($pagina['next_cursor'])) {
                return;
            }
            $filtros['cursor'] = $pagina['next_cursor'];
        }
    }

    // ------------------------------------------------------------- Internos

    private function emitir(string $ruta, array $body, ?string $clave): array
    {
        return $this->json('POST', $ruta, [], $body, $clave ?: self::uuid4());
    }

    private function json(string $metodo, string $ruta, array $query = [], ?array $body = null, ?string $clave = null): array
    {
        $res = $this->solicitar($metodo, $ruta, $query, $body, $clave);
        $datos = json_decode($res['body'], true);
        if (!is_array($datos)) {
            throw new SharkposException('La respuesta de la API no es JSON válido.', 'INVALID_RESPONSE', null, $res['status']);
        }
        return $datos;
    }

    /** @return array{status:int, body:string} */
    private function solicitar(string $metodo, string $ruta, array $query = [], ?array $body = null, ?string $clave = null): array
    {
        $url = $this->baseUrl . $ruta;
        $query = array_filter($query, fn($v) => $v !== null);
        if ($query) {
            $url .= '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
        }
        $seguro = $metodo === 'GET' || $clave !== null;

        for ($intento = 0;; $intento++) {
            $cabeceras = [];
            $headers = ['Authorization: Bearer ' . $this->apiKey, 'Accept: application/json', 'User-Agent: sharkpos-php/0.1.0'];
            if ($body !== null) {
                $headers[] = 'Content-Type: application/json';
            }
            if ($clave !== null) {
                $headers[] = 'Idempotency-Key: ' . $clave;
            }
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_CUSTOMREQUEST => $metodo,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => $this->timeout,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_HEADERFUNCTION => function ($ch, $linea) use (&$cabeceras) {
                    $partes = explode(':', $linea, 2);
                    if (count($partes) === 2) {
                        $cabeceras[strtolower(trim($partes[0]))] = trim($partes[1]);
                    }
                    return strlen($linea);
                },
            ]);
            if ($body !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
            }
            $contenido = curl_exec($ch);
            $errno = curl_errno($ch);
            $estado = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $detalle = curl_error($ch);
            curl_close($ch);

            $retryAfter = isset($cabeceras['retry-after']) && is_numeric($cabeceras['retry-after']) ? (float) $cabeceras['retry-after'] : null;

            if ($errno !== 0) {
                if (!$seguro || $intento >= $this->maxRetries) {
                    throw new SharkposException("No se pudo conectar con SharkPOS API ($detalle).", 'CONNECTION_FAILED', 'Revisa tu conexión y reintenta con la misma Idempotency-Key.');
                }
            } elseif ($estado >= 200 && $estado < 300) {
                return ['status' => $estado, 'body' => (string) $contenido];
            } else {
                $reintentable = in_array($estado, [429, 500, 502, 503, 504], true) && ($estado === 429 || $seguro);
                if (!$reintentable || $intento >= $this->maxRetries) {
                    $datos = json_decode((string) $contenido, true);
                    $datos = is_array($datos) ? $datos : [];
                    throw new SharkposException(
                        $datos['message'] ?? "La API respondió con error HTTP $estado.",
                        $datos['code'] ?? "HTTP_$estado",
                        $datos['solution'] ?? null,
                        $estado,
                        $datos
                    );
                }
            }
            $espera = $retryAfter !== null ? min(max($retryAfter, 0.0), 60.0) : min($this->backoff * (2 ** $intento), 60.0);
            usleep((int) ($espera * 1_000_000));
        }
    }

    private static function uuid4(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
