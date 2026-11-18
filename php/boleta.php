<?php
// Ejemplo de SharkPOS API (sandbox). Guía: https://api.sharkpos.cl/guias/boleta-electronica-php/
// Variable de entorno: SHARKPOS_API_KEY. Nunca pongas la API key en el código.

const BASE = 'https://sandbox.sharkpos.cl/api/v1/dte';

function sharkpos(string $metodo, string $ruta, ?array $body, string $idemKey = null): array
{
    $headers = [
        'Authorization: Bearer ' . getenv('SHARKPOS_API_KEY'),
        'Content-Type: application/json',
    ];
    if ($idemKey !== null) {
        $headers[] = 'Idempotency-Key: ' . $idemKey;
    }

    $retryAfter = null;
    $ch = curl_init(BASE . $ruta);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $metodo,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_POSTFIELDS     => $body !== null ? json_encode($body, JSON_UNESCAPED_UNICODE) : null,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_HEADERFUNCTION => function ($ch, $linea) use (&$retryAfter) {
            if (stripos($linea, 'Retry-After:') === 0) {
                $retryAfter = (int) trim(substr($linea, 12));
            }
            return strlen($linea);
        },
    ]);
    $respuesta = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return [$status, $respuesta === false ? null : json_decode($respuesta, true), $retryAfter];
}

$boleta = [
    'document_type' => 39,
    'amount_total'  => 16980,
    'medio_pago'    => 1,
    'items'         => [
        ['name' => 'Ñoquis a la boloñesa', 'qty' => 1, 'price' => 8990],
        ['name' => 'Café cortado',         'qty' => 2, 'price' => 3995],
    ],
];

[$status, $data] = sharkpos('POST', '/boleta/emit/', $boleta, 'venta-884');
echo $status, ' ', json_encode($data), PHP_EOL;


function emitirBoleta(string $ventaId, array $body, int $intentos = 5): array
{
    $espera = 2;
    for ($i = 0; $i < $intentos; $i++) {
        [$status, $data, $retryAfter] = sharkpos('POST', '/boleta/emit/', $body, $ventaId);

        if ($status === 200 || $status === 201) {
            return $data;
        }
        if ($status === 429) {
            sleep($retryAfter ?: $espera);
            continue;
        }
        if ($status === 0 || $status === 202 || $status >= 500) {
            sleep($espera);
            $espera *= 2;
            continue;
        }
        // Otro 4xx: no reintentar
        throw new RuntimeException(
            ($data['code'] ?? 'ERROR') . ': ' . ($data['message'] ?? '') . ' ' . ($data['solution'] ?? '')
        );
    }
    throw new RuntimeException('Sin respuesta definitiva; reintenta con la misma Idempotency-Key');
}


function esperarResultado(string $dteId, int $maximo = 8): array
{
    $espera = 30;
    for ($i = 0; $i < $maximo; $i++) {
        [, $doc] = sharkpos('GET', "/documents/{$dteId}/", null);
        if (!empty($doc['is_final'])) {
            return $doc;
        }
        sleep($espera);
        $espera = min($espera * 2, 300);
    }
    return $doc;
}

$emitida = emitirBoleta('venta-884', $boleta);
$doc = esperarResultado($emitida['dte_id']);
echo $doc['public_status'], ' ', $doc['message'], PHP_EOL;
