<?php
// Router del servidor simulado: php -S 127.0.0.1:PUERTO tests/servidor_simulado.php
// Guarda las solicitudes en un archivo temporal para que la prueba las inspeccione.
$ruta = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$log = sys_get_temp_dir() . '/sharkpos_php_mock.log';
$cabeceras = array_change_key_case(getallheaders(), CASE_LOWER);
file_put_contents($log, json_encode([
    'method' => $_SERVER['REQUEST_METHOD'], 'uri' => $_SERVER['REQUEST_URI'],
    'auth' => $cabeceras['authorization'] ?? null, 'key' => $cabeceras['idempotency-key'] ?? null,
    'body' => file_get_contents('php://input'),
]) . "\n", FILE_APPEND);
$contador = sys_get_temp_dir() . '/sharkpos_php_mock.count';

header('Content-Type: application/json');
if ($ruta === '/api/v1/dte/boleta/emit/') {
    $n = (int) @file_get_contents($contador);
    file_put_contents($contador, $n + 1);
    if ($n === 0) { // primer intento: 503 para probar el reintento con la misma clave
        http_response_code(503);
        echo json_encode(['status' => 'error', 'code' => 'SII_UNAVAILABLE', 'message' => 'caído']);
    } else {
        http_response_code(201);
        echo json_encode(['status' => 'success', 'dte_id' => 'abc', 'folio' => 7]);
    }
} elseif ($ruta === '/api/v1/dte/documents/abc/') {
    echo json_encode(['status' => 'ok', 'dte_status' => 'ACCEPTED']);
} elseif ($ruta === '/api/v1/dte/boleta/abc/pdf/') {
    header('Content-Type: application/pdf');
    echo '%PDF-1.4 fake';
} elseif ($ruta === '/api/v1/dte/documents/') {
    $pagina2 = isset($_GET['cursor']);
    echo json_encode($pagina2
        ? ['documents' => [['id' => 3]], 'has_more' => false, 'next_cursor' => null]
        : ['documents' => [['id' => 1], ['id' => 2]], 'has_more' => true, 'next_cursor' => 'c1']);
} elseif ($ruta === '/api/v1/dte/factura/emit/') {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'code' => 'INVALID_REQUEST', 'message' => 'Monto inválido', 'solution' => 'Revisa amount_total']);
} else {
    http_response_code(404);
    echo json_encode(['status' => 'error', 'code' => 'NOT_FOUND', 'message' => 'x']);
}
