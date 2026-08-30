# Protocolo dispositivo ↔ backend (v1)

Este documento es **normativo**: el firmware del ESP32S3 y el cliente mock de escritorio
deben implementarlo de forma idéntica. Si cambias algo aquí, cambian los dos.

## 1. Transporte

Un único WebSocket por dispositivo.

```
ws://<host>:8787/device?dock=mesa-01&token=<device_token>
```

| Parámetro | Obligatorio | Descripción |
|---|---|---|
| `dock`   | sí | Identificador de la mesa/soporte. Es lo que ata el gadget a la pantalla del teléfono. |
| `token`  | no (dev) | Token del dispositivo. En desarrollo se acepta ausente. |

Sobre ese mismo socket viajan dos tipos de frame, y **el tipo de frame decide el
significado**:

- **Frames de texto** → mensajes de control en JSON.
- **Frames binarios** → audio PCM.

Esta separación evita base64 (que infla 33 % y quema CPU en el ESP32) y permite al
firmware escribir el audio directo desde el buffer de I2S.

## 2. Frames binarios de audio

Cabecera de **8 bytes**, little-endian, seguida de las muestras PCM.

```
 offset  size  campo      descripción
 ------  ----  ---------  ----------------------------------------------------
   0      1    magic      0xA5
   1      1    version    0x01
   2      1    type       0x01 = mic (dispositivo → backend)
                          0x02 = speaker (backend → dispositivo)
   3      1    flags      bit0 = VAD activo
                          bit1 = fin de locución
                          bit2 = frame de confort/silencio
   4      2    seq        uint16, incrementa por frame, envuelve en 0xFFFF
   6      2    doa        uint16, grados 0..359. 0xFFFF = desconocido
   8      N    pcm        PCM16 little-endian, mono
```

**Formato de audio fijo en v1:** 16 kHz, 16 bits con signo, mono.
**Tamaño de frame recomendado:** 20 ms = 320 muestras = 640 bytes de PCM → 648 bytes en total.

> El backend reamplifica/reamostrea a lo que pida el proveedor de voz (hoy 24 kHz).
> El dispositivo **siempre** habla 16 kHz. Así el firmware queda tonto y estable.

`doa` viaja en la cabecera de audio, no en JSON, porque cambia por frame y sirve para
saber **quién** de la mesa está hablando sin coste de parseo.

## 3. Mensajes JSON — dispositivo → backend

Todos llevan `t` (type).

### `hello` — primer mensaje tras conectar
```json
{
  "t": "hello",
  "proto": 1,
  "dock": "mesa-01",
  "device": { "id": "xiao-68ee8f51e544", "model": "respeaker-xvf3800", "fw": "0.1.0" },
  "audio":  { "rate": 16000, "bits": 16, "ch": 1, "frameMs": 20 },
  "caps":   ["doa", "vad", "aec", "beamforming"]
}
```

### `telemetry` — máximo 5 Hz
```json
{ "t": "telemetry", "vad": true, "doa": 143, "rms": 2210 }
```

### `button` — pulsador físico del soporte
```json
{ "t": "button", "id": "call_waiter" }
```

### `bye`
```json
{ "t": "bye", "reason": "power_off" }
```

## 4. Mensajes JSON — backend → dispositivo

### `welcome` — respuesta a `hello`
```json
{
  "t": "welcome",
  "session": "s_9f3a…",
  "audio": { "rate": 16000, "bits": 16, "ch": 1, "frameMs": 20 },
  "keepaliveMs": 15000
}
```

### `agent_state` — para LEDs y para saber si hay que atenuar el micrófono
```json
{ "t": "agent_state", "state": "listening" }
```
`state` ∈ `idle` | `listening` | `thinking` | `talking`.

### `audio_reset` — **barge-in**
```json
{ "t": "audio_reset" }
```
El dispositivo debe **vaciar de inmediato** su buffer de reproducción y callar el parlante.
Es el mensaje más importante para que la interrupción se sienta natural: si el firmware
sigue drenando su buffer, el cliente escucha al agente hablando encima de él.

### `led`
```json
{ "t": "led", "mode": "listening", "doa": 143 }
```

### `ping` / `pong`
El backend manda `{"t":"ping","ts":…}` cada `keepaliveMs`. El dispositivo responde
`{"t":"pong","ts":…}` con el mismo `ts`. Si el dispositivo no ve un `ping` en
`3 × keepaliveMs`, reconecta.

## 5. Reglas de comportamiento

1. **Orden de apertura.** El dispositivo no envía audio hasta recibir `welcome`.
2. **Reconexión.** Backoff exponencial con jitter: 0.5 s, 1 s, 2 s, 4 s, máx. 10 s.
   Al reconectar con el mismo `dock`, el backend reengancha la sesión existente si
   sigue viva (ventana de 60 s), así el pedido no se pierde.
3. **Barge-in.** El dispositivo transmite el micrófono **siempre**, incluso mientras el
   agente habla. El AEC del XVF3800 ya quita el eco del parlante, así que no hay que
   silenciar el micro. La decisión de interrumpir la toma el backend.
4. **Jitter buffer.** El dispositivo debe acumular ~60 ms antes de empezar a reproducir,
   y descartar el frame más viejo si el buffer supera 400 ms.
5. **Sin audio que enviar.** Si no hay voz, el dispositivo puede omitir frames; no debe
   mandar silencio continuo salvo que quiera mantener el AEC alimentado (`flags` bit2).

## 6. Canal de la pantalla (backend ↔ Web UI)

Segundo WebSocket, **solo JSON**, que es lo que hace que el teléfono siga al gadget:

```
ws://<host>:8787/ui?dock=mesa-01
```

El backend manda un `snapshot` al conectar y luego parches:

```json
{ "t": "snapshot", "session": "s_9f3a…", "agentState": "listening",
  "screen": "menu", "order": { "items": [], "total": 0 }, "transcript": [] }

{ "t": "agent_state", "state": "talking" }
{ "t": "transcript", "role": "user", "text": "quiero una bandeja paisa" }
{ "t": "order", "items": [ { "sku": "bandeja-paisa", "qty": 1, "price": 32000 } ], "total": 32000 }
{ "t": "screen", "name": "order_review" }
{ "t": "payment", "status": "pending", "url": "https://checkout.wompi.co/l/…" }
```

Además, para que la pantalla y el POS sigan la cocina y la carta en vivo:

```json
{ "t": "vad", "vad": true }
{ "t": "menu", "menu": { "restaurant": "…", "categories": [ … ] } }
```

- `vad` refleja si el micrófono está oyendo voz; la pantalla lo usa para animar
  el anillo cuando habla el cliente (cuando habla el agente ya llega `agent_state`).
- `menu` se emite a todas las mesas cuando el POS guarda la carta.

Dentro de `state` viajan también los **tickets**: cada `confirm_order` congela la
ronda en `state.tickets[]` (`{ id, n, status, sentAt }`), y los items confirmados
llevan `ticket: <id>`. `status` ∈ `kitchen` | `preparing` | `ready` | `served`, y lo
avanza el POS por HTTP:

```
PUT  /api/menu                                  guarda la carta (CRUD del POS)
POST /api/dock/:dock/ticket/:id/status          { "status": "preparing" }
POST /api/dock/:dock/reset                      libera la mesa
POST /api/dock/:dock/tool                       { "name": "add_item", "args": {…}, "doa": 40 }
```

`/tool` aplica una herramienta del pack como si la hubiera llamado el modelo —
mismo reducer, mismo fan-out — y es lo que usa un demo o un POS para editar un
pedido a mano.

La UI es **solo pantalla**: no captura audio y no manda comandos de voz. Lo único que
puede emitir es interacción táctil de respaldo:

```json
{ "t": "ui_action", "action": "call_waiter" }
```

## 7. Por qué así

- **Un solo socket para audio y control** evita desincronización entre el estado del
  agente y el audio que se está reproduciendo, y ahorra un TLS en el ESP32.
- **Binario crudo para audio** mantiene el firmware simple y el ancho de banda bajo:
  16 kHz mono PCM16 = 256 kbps por sentido, cómodo para WiFi de restaurante.
- **El dispositivo no sabe nada del proveedor de voz.** Puede cambiarse OpenAI Realtime
  por Azure o Gemini sin tocar el firmware. Esa es la razón de que el backend reamostree
  en vez de exigirle 24 kHz al ESP32.
