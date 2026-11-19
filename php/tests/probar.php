<?php
// Uso: php tests/probar.php   (levanta el servidor simulado en un puerto local libre; no usa la red real)
require __DIR__ . '/../SharkposClient.php';

$puerto = 18000 + random_int(0, 999);
$tmp = sys_get_temp_dir();
@unlink("$tmp/sharkpos_php_mock.log");
@unlink("$tmp/sharkpos_php_mock.count");
$nulo = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
$proc = proc_open([PHP_BINARY, '-S', "127.0.0.1:$puerto", __DIR__ . '/servidor_simulado.php'], [1 => ['file', $nulo, 'w'], 2 => ['file', $nulo, 'w']], $pipes);
register_shutdown_function(fn() => proc_terminate($proc));
for ($i = 0; $i < 50; $i++) { // espera a que escuche
    if (@fsockopen('127.0.0.1', $puerto)) break;
    usleep(100000);
}

$fallos = 0;
function ok(bool $cond, string $nombre): void
{
    global $fallos;
    echo ($cond ? 'OK   ' : 'FALLA') . " $nombre\n";
    if (!$cond) $fallos++;
}

$c = new SharkposClient('test-key', false, "http://127.0.0.1:$puerto", 10, 3, 0.01);

$r = $c->emitirBoleta(['amount_total' => 100, 'items' => [['name' => 'Ñandú', 'price' => 100]]], 'venta-1');
ok($r['folio'] === 7, 'emitirBoleta reintenta el 503 y devuelve el folio');
$lineas = array_map(fn($l) => json_decode($l, true), file("$tmp/sharkpos_php_mock.log", FILE_IGNORE_NEW_LINES));
ok(count($lineas) === 2, 'hizo 2 solicitudes (503 y luego 201)');
ok($lineas[0]['key'] === 'venta-1' && $lineas[1]['key'] === 'venta-1', 'misma Idempotency-Key en el reintento');
ok($lineas[0]['auth'] === 'Bearer test-key', 'Authorization Bearer');
ok(str_contains($lineas[0]['body'], 'Ñandú'), 'cuerpo UTF-8 sin escapar');

ok($c->estado('abc')['dte_status'] === 'ACCEPTED', 'estado()');
ok($c->pdfBoleta('abc', 58) === '%PDF-1.4 fake', 'pdfBoleta()');
ok(array_column(iterator_to_array($c->todos(['period' => '2026-10']), false), 'id') === [1, 2, 3], 'todos() sigue el cursor');

try {
    $c->emitirFactura(['x' => 1]);
    ok(false, 'error 400 lanza excepción');
} catch (SharkposException $e) {
    ok($e->errorCode === 'INVALID_REQUEST' && $e->solution === 'Revisa amount_total' && $e->httpStatus === 400, 'error 400 con code/solution');
}

try {
    new SharkposClient('');
    ok(false, 'exige API key');
} catch (SharkposException $e) {
    ok($e->errorCode === 'API_KEY_MISSING', 'exige API key');
}

echo $fallos === 0 ? "Todo bien\n" : "$fallos fallas\n";
exit($fallos === 0 ? 0 : 1);
