<?php
// Laravel (Http client). Guía: https://api.sharkpos.cl/guias/boleta-electronica-php/
// En config/services.php: 'sharkpos' => ['key' => env('SHARKPOS_API_KEY')].

use Illuminate\Support\Facades\Http;

$respuesta = Http::withToken(config('services.sharkpos.key'))
    ->withHeaders(['Idempotency-Key' => "venta-{$venta->id}"])
    ->acceptJson()
    ->timeout(30)
    ->retry(3, 2000, fn ($e) => !($e instanceof \Illuminate\Http\Client\RequestException)
        || $e->response->status() >= 500, throw: false)
    ->post('https://sandbox.sharkpos.cl/api/v1/dte/boleta/emit/', [
        'document_type' => 39,
        'amount_total'  => 16980,
        'medio_pago'    => 1,
        'items'         => [
            ['name' => 'Ñoquis a la boloñesa', 'qty' => 1, 'price' => 8990],
            ['name' => 'Café cortado', 'qty' => 2, 'price' => 3995],
        ],
    ]);

if ($respuesta->successful()) {
    $folio = $respuesta->json('folio');
    $dteId = $respuesta->json('dte_id');
} else {
    // 4xx: corrige; message y solution vienen listos para mostrar
    logger()->warning($respuesta->json('code') . ': ' . $respuesta->json('message'));
}
