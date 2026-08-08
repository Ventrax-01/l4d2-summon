# L4D2 Panel — Diseño técnico 01: Modelo de datos (DynamoDB single-table)

> Fuente de verdad de decisiones: `docs/especificaciones-v1.md` (ADR D1–D17).
> Este documento es el diseño **implementable** del modelo de datos. No re-litiga los ADR.
> Ámbito: **una** tabla DynamoDB `l4d2-panel`, provisioned **25 RCU / 25 WCU**, región
> `us-east-2`, cuenta `211125402452`. **Sin on-demand. Sin GSIs.** Los bans NO viven aquí
> (van en la MySQL local de SourceBans++, ADR D12/D16).

---

## 0. Resumen de decisiones de diseño

1. **Single-table** con claves genéricas `PK` (S) y `SK` (S). Todo se resuelve por `PK`/`SK`
   o por punteros denormalizados en el perfil del usuario. **Cero GSIs** (justificado en §3).
2. **Cola FIFO con contador atómico** + `SK` numérico con padding + prefijo de **tier** para
   el hook premium (saltar cola) sin migración futura. La **posición no se materializa**: se
   calcula con un `Query … Select=COUNT` (evita reescrituras O(n) al encolar/salir).
3. **Claim atómico de slot** vía `TransactWriteItems` que combina tres invariantes: reservas
   abiertas + `idx ≤ N` (ConditionCheck sobre `CONFIG`), slot `LIBRE` (condición sobre el slot)
   y usuario sin reserva ni cola ni suspensión (condición sobre el perfil). Un único ganador.
4. **Reconciliación desired-state**: la API escribe el estado *deseado* (`deseado`,
   `estadoReserva`), el agente reporta el estado *real* (`procesoEstado`, runtime) y reconcilia.
   No hay cola de comandos: el estado de la tabla ES el comando. Idempotente por construcción
   ("si dos personas piden a la vez, convergen").
5. El agente **escribe solo en cambio** (runtime del slot) salvo el **heartbeat** del `HOST`,
   que sí es cada poll. Mantiene el gasto de WCU casi nulo.
6. **Tres estados mutuamente excluyentes por usuario**, cada uno con su representación:
   *arranque en curso* = ítem `INTENT` (efímero, para el stepper); *reserva activa* = `slot.owner`
   (durable) + puntero `usuario.slotActual`; *en cola* = entrada `QUEUE` + puntero
   `usuario.colaSeq`. Los invariantes garantizan que no coexisten.
7. **TTL solo como backstop** de limpieza (intents y locks abandonados). Las expiraciones
   *precisas* (timeouts de intent, ventana de aceptación de cola, reintentos de WoL) las maneja
   **EventBridge Scheduler**, no el TTL (que puede tardar hasta 48 h).

---

## 1. Definición de la tabla

| Propiedad | Valor |
|---|---|
| Nombre | `l4d2-panel` (sufijar por entorno si hace falta: `l4d2-panel-prod`) |
| Región | `us-east-2` |
| Partition key | `PK` (String) |
| Sort key | `SK` (String) |
| Modo de capacidad | **PROVISIONED**, 25 RCU / 25 WCU (free tier permanente) |
| Auto-scaling | **No** (holgura enorme; ver §8). Provisioned fijo. |
| GSIs | **Ninguno** |
| LSIs | Ninguno |
| Atributo TTL | `ttl` (Number, epoch **segundos**) |
| Streams | **Deshabilitado** en v1 (la promoción de cola la dispara un callback del agente; ver §6.4). Opción: `NEW_IMAGE` si más adelante se prefiere disparar por Streams. |
| PITR | Recomendado **ON** (tabla < 1 MB → costo en centavos; seguro barato). Opcional. |
| Deletion protection | ON |

CDK (TypeScript), esqueleto:

```ts
const tabla = new dynamodb.Table(this, 'L4d2PanelTable', {
  tableName: 'l4d2-panel',
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode:  dynamodb.BillingMode.PROVISIONED,
  readCapacity: 25,
  writeCapacity: 25,
  timeToLiveAttribute: 'ttl',
  pointInTimeRecovery: true,
  deletionProtection: true,
  // sin GSIs, sin stream en v1
});
```

Convenciones de atributos comunes en todos los ítems:

- `tipo` (S): discriminador de entidad (`Usuario`, `Config`, `Slot`, `Intent`, `ColaEntry`,
  `Host`, `Counter`, `Lock`). Útil para depurar y para exports.
- `v` (N): número de versión optimista donde se indica (control-plane).
- `actualizado` (S, ISO-8601 UTC) / `creado` (S).
- Timestamps de "hace X": se guardan como **epoch segundos** (N) para comparaciones baratas
  (`vacioDesde`, `ultHeartbeat`, `sourcebansUltUso`, `ttl`, `wakeIntentHasta`). Las fechas
  "humanas" (perfil `creado`) van en ISO-8601. Se documenta por campo.

---

## 2. Mapa de particiones (ASCII)

```
PK                         SK                         Entidad
─────────────────────────  ─────────────────────────  ──────────────────────────────
CONFIG                     GLOBAL                     Config global (N, interruptor…)
HOST                       STATE                      Estado de la PC + heartbeat
HOST                       WOL_LOCK                   Lock de dedupe de magic packet (TTL)
COUNTER                    COLA                       Contador monotónico de la cola
SLOT                       #001                       Slot 1  (puerto 6033)
SLOT                       #002                       Slot 2  (puerto 6034)
SLOT                       #003                       Slot 3  (puerto 6035)
SLOT                       #004                       Slot 4  (puerto 6036)
QUEUE                      ENTRY#1#000…0007           Entrada de cola (tier 1, seq 7)
QUEUE                      ENTRY#1#000…0008           Entrada de cola (tier 1, seq 8)
QUEUE                      ENTRY#0#000…0009           Entrada de cola PREMIUM (tier 0)  ← hook
USER#7656119800000xxxx     PROFILE                    Perfil del usuario
USER#7656119800000xxxx     INTENT                     Arranque de reserva en curso (efímero)
```

Claves de diseño:

- **Todos los slots en una sola partición** (`PK=SLOT`) → **AP1 "listar N slots"** es **un solo
  `Query`** ordenado por `idx`.
- **Toda la info por-usuario en una sola partición** (`PK=USER#<sid>`) → **AP "mi estado"** es
  **un solo `Query`** que trae perfil + intent (y el perfil ya trae los punteros `slotActual`
  y `colaSeq`).
- **Toda la cola en una sola partición** (`PK=QUEUE`) → head, posición y recorrido en `Query`.

`<sid>` = **SteamID64** (17 dígitos), la identidad verificada por el login Steam (D4).

---

## 3. Por qué CERO GSIs (no sobre-ingeniería)

Cada patrón de acceso se resuelve por clave primaria o por un puntero en el perfil:

| Lo que uno pensaría que necesita GSI | Cómo se resuelve sin GSI |
|---|---|
| "¿Qué slot tiene reservado el usuario X?" | Puntero `usuario.slotActual` (denormalizado, escrito **atómicamente** con el claim). |
| "¿Quién es el dueño del slot k?" | Atributo `slot.owner` (lectura directa del slot). |
| "¿En qué posición de la cola está X?" | Puntero `usuario.colaSeq` + `Query … Select=COUNT`. |
| "Cabeza de la cola" | `Query PK=QUEUE, ScanIndexForward=true, Limit=1`. |
| "Usuarios operadores / suspendidos" | Operación rara del operador → `Scan` puntual (tabla diminuta). |

Un GSI se paga con **capacidad provisionada propia** (otros 25/25 no caben "gratis" en el free
tier: el mínimo de 25 RCU + 25 WCU del free tier es agregado de tabla **y** GSIs). Con cero GSIs,
los 25/25 son íntegros para la tabla base. **Candidato futuro único** (si algún día se quita el
puntero `slotActual`): un GSI *sparse* `owner → slot`. En v1 **no hace falta**; añadirlo ahora
sería sobre-ingeniería.

---

## 4. Entidades e ítems (esquema + JSON)

### 4.1 Config global — `PK=CONFIG`, `SK=GLOBAL`

Resuelve **AP5** (N actual + interruptor de reservas). Ítem "caliente" de lectura → **cachear en
memoria de la Lambda** con TTL de ~60 s para no gastar RCU en cada request.

```json
{
  "PK": "CONFIG",
  "SK": "GLOBAL",
  "tipo": "Config",
  "n": 4,                      // tope de slots activos (D6). DINÁMICO — nunca hardcodear 4.
  "portBase": 6032,            // puerto de juego = portBase + idx  (idx 1 → 6033/udp)
  "reservasAbiertas": true,    // interruptor global (D6/§15). false = nadie puede reservar.
  "maxEncendidosDia": 20,      // rate-limit de arranques de PC por día (§15). 0 = sin límite.
  "cooldownSegundos": 30,      // cooldown entre operaciones de reserva por usuario (§15)
  "vacioCierreSeg": 900,       // 15 min: un servidor vacío se cierra (D11/§7)
  "sourcebansSostenSeg": 600,  // 10 min: SourceBans mantiene viva la PC (§7 sostén #3)
  "heartbeatTimeoutSeg": 40,   // sin heartbeat > 40 s → PC se considera caída/apagada
  "v": 7,
  "actualizado": "2026-08-07T15:00:00Z"
}
```

- `n`, `reservasAbiertas` y los rate-limits los cambia el operador a mano (por DB/SSH en v1, D17).
- El claim (§5) valida `reservasAbiertas` e `idx ≤ n` **dentro de la transacción** (ConditionCheck),
  así que un cambio de `n`/interruptor es efectivo aunque haya lecturas cacheadas viejas.

### 4.2 Slot / Servidor — `PK=SLOT`, `SK=#<idx zero-pad 3>`

Resuelve **AP1** (un `Query PK=SLOT` los trae todos, ordenados por `idx`). Un ítem por slot,
sembrado al fijar `n`. Combina **control-plane** (API-owned) y **runtime** (agent-owned) en el
mismo ítem, con atributos disjuntos (ver §5.4 sobre por qué no colisionan).

```json
{
  "PK": "SLOT",
  "SK": "#003",
  "tipo": "Slot",
  "idx": 3,
  "puerto": 6035,                 // portBase + idx  (informativo; se puede derivar)

  // --- control-plane (lo escribe la API en claim/free) ---
  "estadoReserva": "RESERVADO",   // LIBRE | RESERVADO | CERRANDO | DESHABILITADO
  "deseado": "ENCENDIDO",         // ENCENDIDO | APAGADO  (estado deseado para el agente)
  "owner": "76561198000000003",   // SteamID64 del reservador (ausente si LIBRE)
  "ownerNick": "Zoey",
  "inicio": 1754579400,           // epoch s en que se reservó
  "v": 12,                        // versión optimista del control-plane

  // --- runtime (lo escribe el AGENTE, solo en cambio) ---
  "procesoEstado": "ARRIBA",      // APAGADO | ARRANCANDO | ARRIBA | CAIDO
  "mapa": "c2m1_highway",
  "jugadores": 6,
  "bots": 2,
  "maxJugadores": 8,
  "vacioDesde": 0,                // epoch s en que quedó vacío (0/ausente = no vacío). Para el cierre a 15 min.
  "ultRuntime": 1754579600        // epoch s del último reporte del agente para este slot
}
```

Ítem de un slot **libre**:

```json
{
  "PK": "SLOT", "SK": "#001", "tipo": "Slot", "idx": 1, "puerto": 6033,
  "estadoReserva": "LIBRE", "deseado": "APAGADO", "procesoEstado": "APAGADO",
  "jugadores": 0, "bots": 0, "v": 8, "ultRuntime": 1754579590
}
```

- El **`steam://connect`** que se entrega al jugador se construye en tiempo de lectura:
  `steam://connect/<HOST.ipPublica>:<slot.puerto>` (la IP de casa cambia → NO se guarda en el slot).
- Estado que ve el jugador en la lista (derivado en el front/API): `LIBRE` (verde),
  `PREPARANDO` (`RESERVADO` + `procesoEstado∈{ARRANCANDO}`), `EN JUEGO` (`RESERVADO` +
  `ARRIBA`, muestra owner/mapa/jugadores), `CERRANDO`, `NO DISPONIBLE` (`DESHABILITADO`/`CAIDO`).
- **Provisión de slots**: subir `n` de 4→6 = `PutItem` de `#005`/`#006` en `LIBRE`. Bajar `n` =
  marcar `estadoReserva=DESHABILITADO` los `idx>n` (drenar primero si están ocupados). El claim
  ya bloquea `idx>n` por el ConditionCheck sobre `CONFIG`, así que un slot huérfano `LIBRE` con
  `idx>n` nunca se reclama.

### 4.3 Usuario / Perfil — `PK=USER#<sid>`, `SK=PROFILE`

Resuelve **AP3** (perfil) y, vía punteros, **AP2** (reserva activa) y **AP8** (posición en cola).

```json
{
  "PK": "USER#76561198000000003",
  "SK": "PROFILE",
  "tipo": "Usuario",
  "steamId64": "76561198000000003",
  "nick": "Zoey",
  "avatar": "https://avatars.steamstatic.com/xxxx_full.jpg",
  "operador": false,             // flag operador (§6 spec). El operador lo pone a true a mano.
  "suspendido": false,           // moderación mínima (§15). true = la API rechaza reservar/encolar.

  // punteros de estado (a lo sumo UNO presente a la vez; invariantes en §5)
  "slotActual": 3,               // idx del slot reservado (ausente si no tiene reserva)
  "colaSeq": null,               // seq en la cola (ausente/null si no está en cola)

  // hook premium (D15) — hoy nulo, sin uso
  "premium": false,
  "plan": null,                  // reservado para planes de pago (fuera de v1)

  "encendidosHoy": 2,            // contador de arranques de PC del día (rate-limit §15)
  "encendidosDia": "2026-08-07", // fecha del contador (se resetea al cambiar de día)
  "ultReserva": 1754579400,      // epoch s de la última reserva (cooldown §15)
  "creado": "2026-07-01T12:00:00Z",
  "actualizado": "2026-08-07T15:03:20Z"
}
```

- **AP2 (reserva activa de un usuario)**: `GetItem PROFILE` → si `slotActual` presente,
  `GetItem SLOT/#00k` para el `steam://connect` y el estado. En la SPA basta **un
  `Query PK=USER#<sid>`** (trae PROFILE + INTENT) y, si hay `slotActual`, **un `GetItem`** del slot.
- Los punteros `slotActual`/`colaSeq` se escriben **siempre en la misma transacción** que muta el
  slot o la cola (nunca por separado) → no divergen del `slot.owner` / entrada de cola.

### 4.4 Intent — `PK=USER#<sid>`, `SK=INTENT`

Resuelve **AP4** (arranque en curso). **Efímero**: existe solo mientras el arranque está en
marcha (para pintar el stepper DESPERTANDO → INICIANDO → VERIFICANDO → LISTO). Cuando el
servidor queda `ARRIBA`, la reserva "durable" es el `slot.owner`; el intent se borra o se deja
morir por TTL (backstop). Un solo intent por usuario (SK fijo) → convergen los doble-clicks.

```json
{
  "PK": "USER#76561198000000003",
  "SK": "INTENT",
  "tipo": "Intent",
  "estado": "VERIFICANDO",       // SOLICITADO|EN_COLA|DESPERTANDO|INICIANDO|VERIFICANDO|LISTO|ERROR|CANCELADO
  "slot": 3,                     // idx asignado (ausente mientras EN_COLA sin slot)
  "etapaTexto": "Verificando servidor…",  // texto de UI (sin mencionar PC/infra, §8)
  "intentos": 1,                 // reintentos de arranque/WoL
  "mensaje": null,               // en ERROR: motivo honesto para el usuario (§8)
  "creado": 1754579400,          // epoch s
  "actualizado": 1754579455,
  "ttl": 1754583000              // backstop: creado + 60 min. Timeout real vía Scheduler.
}
```

Máquina de estados (referencia; la lógica vive en las Lambdas + agente):

```
                 slot libre & PC arriba
  SOLICITADO ───────────────────────────► INICIANDO ─► VERIFICANDO ─► LISTO
      │  slot libre & PC apagada                                        │
      ├──────────────────► DESPERTANDO ─► INICIANDO ─► VERIFICANDO ─────┘
      │  N ocupados
      └──────────────────► EN_COLA ──(se libera slot; promoción §6.4)──► INICIANDO …

  cualquier estado ── fallo ──► ERROR ──(reintento)──► DESPERTANDO/INICIANDO
  cualquier estado ── usuario cancela ──► CANCELADO (se borra el ítem)
```

### 4.5 Entrada de cola — `PK=QUEUE`, `SK=ENTRY#<tier>#<seq zero-pad 20>`

Resuelve la **cola FIFO** (AP7 encolar, AP8 posición, AP9 head, AP10 salir).

```json
{
  "PK": "QUEUE",
  "SK": "ENTRY#1#00000000000000000007",
  "tipo": "ColaEntry",
  "tier": 1,                     // 0 = premium (hook D15) · 1 = normal. Hoy todos = 1.
  "seq": 7,                      // valor del contador atómico (orden estable)
  "steamId64": "76561198000000009",
  "nick": "Francis",
  "encolado": 1754579420         // epoch s
}
```

- **Orden = orden lexicográfico del `SK`** = `(tier, seq)`. `ScanIndexForward=true` (ascendente)
  → primero todos los tier 0 (premium), luego tier 1, y dentro de cada tier por `seq` creciente
  (FIFO estricto). El **hook premium** ya está horneado: un premium encola con `tier=0` y salta
  al frente sin cambiar el esquema.
- `seq` sale del **contador atómico** (`PK=COUNTER, SK=COLA`), no de un timestamp → orden estable
  aunque dos usuarios encolen en el mismo milisegundo.
- La **posición NO se guarda** en el ítem: se calcula con `Query … Select=COUNT` (AP8). Así,
  encolar o salir **no reescribe** las demás entradas (evita O(n) writes por operación).
- **Sin TTL**: una entrada de cola no debe desaparecer sola (perdería el turno de alguien). La
  limpieza de un usuario que nunca acepta al ser promovido la maneja la ventana de aceptación
  (Scheduler, §6.4), no el TTL.

### 4.6 Host / PC — `PK=HOST`, `SK=STATE`

Resuelve **AP6** (heartbeat + estado PC + IP pública actual). Ítem único (una sola PC).

```json
{
  "PK": "HOST",
  "SK": "STATE",
  "tipo": "Host",
  "estado": "ARRIBA",            // APAGADA | DESPERTANDO | ARRIBA | APAGANDO  (derivable de ultHeartbeat)
  "ultHeartbeat": 1754579600,    // epoch s del último poll del agente. Liveness = now - ultHeartbeat < heartbeatTimeoutSeg
  "ipPublica": "190.123.45.67",  // IP pública actual de casa (para steam://connect y DDNS). El agente la reporta.
  "bootId": "2026-08-07T14:58:10Z", // marca del arranque en curso (para correlacionar)
  "wakeIntentHasta": 0,          // epoch s hasta el cual hay un WoL en vuelo (sostén #2 §7). 0 = ninguno.
  "sourcebansUltUso": 1754579000,// epoch s del último uso de /sourcebans (sostén #3 §7)
  "v": 45,
  "actualizado": "2026-08-07T15:03:20Z"
}
```

- **`estado` derivado**: la API no confía ciegamente en `estado`; calcula liveness con
  `now - ultHeartbeat < CONFIG.heartbeatTimeoutSeg`. La Lambda de WoL pone `estado=DESPERTANDO`
  y `wakeIntentHasta=now+300` al enviar el magic packet.
- **`sourcebansUltUso`**: lo actualiza la Lambda de wake-on-uso de `/sourcebans` (solo operador,
  D13/§9) con `SET sourcebansUltUso=:now`. El agente lo lee para el sostén #3.
- **Auto-apagado (§7)**: la lógica de sostenes vive en el **agente** (local), que en cada poll lee
  `HOST` + `SLOT*` + `CONFIG` y decide `poweroff` cuando **ningún** sostén aplica:
  1. algún slot con `jugadores>0` **o** `vacioDesde` hace < `vacioCierreSeg` (15 min);
  2. `wakeIntentHasta > now` **o** algún slot `RESERVADO` con `procesoEstado≠ARRIBA` (arranque en vuelo);
  3. `now - sourcebansUltUso < sourcebansSostenSeg` (10 min);
  4. sesión SSH del operador (dato **local**, no en DynamoDB).
  Además, cola no vacía + slots por liberarse cuenta como actividad (§10): el agente ve
  `Query PK=QUEUE Limit=1` no vacío.

### 4.7 WoL lock — `PK=HOST`, `SK=WOL_LOCK` (TTL)

Dedupe de magic packets: evita que dos requests concurrentes disparen ráfagas de WoL. Se toma con
condición y expira solo por TTL.

```json
{ "PK": "HOST", "SK": "WOL_LOCK", "tipo": "Lock", "tomadoPor": "intent:76561198000000003",
  "creado": 1754579400, "ttl": 1754579490 }   // ttl = creado + 90 s (ventana de dedupe)
```

### 4.8 Contador de cola — `PK=COUNTER`, `SK=COLA`

```json
{ "PK": "COUNTER", "SK": "COLA", "tipo": "Counter", "seqActual": 9 }
```

---

## 5. Concurrencia (condition expressions concretas)

### 5.1 Claim atómico de un slot (dos usuarios NO reclaman el mismo)

El claim combina **tres invariantes** en un solo `TransactWriteItems` (todo-o-nada). Antes,
la Lambda elige un slot candidato leyendo `Query PK=SLOT` (consistencia eventual OK — se
re-valida con la condición) y toma el `idx` `LIBRE` más bajo con `idx ≤ n`.

```
TransactWriteItems:

  # (a) Guardarraíl global: reservas abiertas y idx dentro de N
  ConditionCheck  Key {PK:"CONFIG", SK:"GLOBAL"}
      ConditionExpression: reservasAbiertas = :true AND :idx <= n

  # (b) Reclamar el slot — SOLO gana si sigue LIBRE
  Update          Key {PK:"SLOT", SK:"#00k"}
      UpdateExpression:
        SET estadoReserva=:reservado, #own=:sid, ownerNick=:nick,
            inicio=:now, deseado=:on, procesoEstado=if_not_exists(procesoEstado,:apagado),
            v = if_not_exists(v,:zero) + :one
      ConditionExpression: estadoReserva = :libre
      # #own = alias de "owner" (palabra reservada)

  # (c) Marcar la reserva en el usuario — SOLO si no tiene reserva, ni cola, ni suspensión
  Update          Key {PK:"USER#<sid>", SK:"PROFILE"}
      UpdateExpression: SET slotActual=:idx, ultReserva=:now, actualizado=:nowIso
      ConditionExpression:
        attribute_exists(PK)
        AND attribute_not_exists(slotActual)
        AND attribute_not_exists(colaSeq)
        AND (attribute_not_exists(suspendido) OR suspendido = :false)

  # (d) Crear el intent del arranque (idempotente)
  Put             Item {PK:"USER#<sid>", SK:"INTENT", estado:"INICIANDO", slot:k, ...}
      ConditionExpression: attribute_not_exists(SK)

Valores: :true=true :false=false :libre="LIBRE" :reservado="RESERVADO"
         :on="ENCENDIDO" :apagado="APAGADO" :zero=0 :one=1
         :idx=<k> :sid=<steamId64> :now=<epoch> :nowIso=<iso>
```

**Resolución de carreras:**
- Dos usuarios apuntan al mismo `#00k` → el `TransactWriteItems` de uno commitea; el del otro
  falla con `TransactionCanceledException`. La razón del cancel indica **qué** condición falló:
  - falla en **(b)** (`estadoReserva ≠ LIBRE`) → el slot ya fue tomado → la Lambda **reintenta**
    con el siguiente `idx` libre (re-`Query`). Si no quedan libres → **encolar** (§5.2).
  - falla en **(c)** → el usuario ya tiene reserva/cola o está suspendido → abortar con mensaje
    ("ya tienes un servidor / ya estás en cola / cuenta suspendida"). No reintentar.
  - falla en **(a)** → reservas cerradas o `idx>n` → abortar con mensaje.
- No hay problema **ABA**: reclamar *cualquier* slot `LIBRE` es correcto; que un slot haya pasado
  por `LIBRE→RESERVADO→LIBRE` entre la lectura y el write no afecta (la condición vuelve a validar
  contra el estado comprometido más reciente).
- **Sin doble-reserva por usuario**: la condición (c) `attribute_not_exists(slotActual)` es el
  candado del ADR D7 ("1 servidor por usuario"), atómico con el claim del slot.

Nota de costo: `TransactWriteItems` cuesta **2× WCU por ítem**. Este claim toca 4 ítems (a,b,c,d)
= **8 WCU** por reserva. Las reservas son raras (unas pocas/hora) → despreciable frente a 25 WCU.

### 5.2 Encolar (FIFO, orden estable)

Dos pasos: (1) incrementar el contador atómico; (2) transacción de alta en cola + puntero.

```
# Paso 1 — reservar un seq monotónico (NO en transacción; un gap por crash es inocuo)
UpdateItem  Key {PK:"COUNTER", SK:"COLA"}
    UpdateExpression: ADD seqActual :one
    ReturnValues: UPDATED_NEW            → devuelve N (p.ej. 10)

# Paso 2 — alta atómica: entrada de cola + puntero en el usuario
TransactWriteItems:
  Put     Item {PK:"QUEUE", SK:"ENTRY#1#<pad20(N)>", tier:1, seq:N,
                steamId64:<sid>, nick:<nick>, encolado:<now>}
      ConditionExpression: attribute_not_exists(SK)          # nuevo seq → siempre cierto

  Update  Key {PK:"USER#<sid>", SK:"PROFILE"}
      UpdateExpression: SET colaSeq=:N, actualizado=:nowIso
      ConditionExpression:
        attribute_exists(PK)
        AND attribute_not_exists(slotActual)                 # no está jugando
        AND attribute_not_exists(colaSeq)                    # no está ya en cola (dedupe)
        AND (attribute_not_exists(suspendido) OR suspendido = :false)
```

Si la transacción falla (usuario ya en cola / ya reservó) se **descarta** el `seq` N (gap inocuo:
la posición se calcula por COUNT, no por continuidad del seq). Premium futuro: idéntico con
`tier=0` y `SK=ENTRY#0#<pad20(N)>`.

### 5.3 Ver posición · head · salir de la cola

```
# Posición (AP8): puntero colaSeq del perfil → construir mySK → contar los que van delante
mySK = "ENTRY#" + tier + "#" + pad20(colaSeq)
Query  KeyConditionExpression: PK = :q AND SK < :mySK
       Select: COUNT
posicion = Count + 1

# Head (AP9)
Query  KeyConditionExpression: PK = :q
       ScanIndexForward: true, Limit: 1     → la entrada de menor (tier, seq)

# Salir de la cola (AP10)
TransactWriteItems:
  Delete  Key {PK:"QUEUE", SK:"ENTRY#<tier>#<pad20(colaSeq)>"}
      ConditionExpression: attribute_exists(SK)
  Update  Key {PK:"USER#<sid>", SK:"PROFILE"}
      UpdateExpression: REMOVE colaSeq
      ConditionExpression: colaSeq = :seq            # optimista: coincide con lo que borramos
```

### 5.4 Promoción de cabeza al liberarse un slot

Se dispara cuando un slot pasa a `LIBRE` **y** hay cola (ver quién lo dispara en §6.4). Un solo
ganador aunque dos liberaciones concurran:

```
head = Query PK=QUEUE, ScanIndexForward=true, Limit=1     # eventual; se re-valida por condición

TransactWriteItems:
  ConditionCheck Key {PK:"CONFIG", SK:"GLOBAL"}
      ConditionExpression: reservasAbiertas = :true AND :idx <= n
  Delete  Key {PK:"QUEUE", SK:"ENTRY#<t>#<pad20(head.seq)>"}
      ConditionExpression: attribute_exists(SK)            # sigue siendo/existiendo la cabeza
  Update  Key {PK:"SLOT", SK:"#00k"}
      UpdateExpression: SET estadoReserva=:reservado, #own=:headSid, ownerNick=:headNick,
                            inicio=:now, deseado=:on, v=v + :one
      ConditionExpression: estadoReserva = :libre         # el slot sigue libre
  Update  Key {PK:"USER#<headSid>", SK:"PROFILE"}
      UpdateExpression: SET slotActual=:idx REMOVE colaSeq
      ConditionExpression: colaSeq = :headSeq AND attribute_not_exists(slotActual)
  Put     Item {PK:"USER#<headSid>", SK:"INTENT", estado:"INICIANDO", slot:k, ...}
      ConditionExpression: attribute_not_exists(SK)
```

Si dos promociones agarran la misma cabeza, o el slot deja de estar `LIBRE`, una transacción
falla y se **reintenta** (nueva cabeza / otro slot). **v1 recomendado: auto-asignar** (arranca el
server del primero de la cola de una vez, porque la PC ya está encendida —un slot recién se
liberó). Los campos para una **ventana de aceptación** (`intent.estado=PROMOVIDO`, Scheduler)
quedan disponibles si se prefiere el flujo "avísale y dale 3 min" (§10) — decisión abierta.

### 5.5 Liberar / cerrar el propio servidor

Dos fases para **no** entregar un server "sucio" (con el admin anterior) al siguiente:

```
# Fase 1 — el usuario cierra (API). Libera al usuario YA (puede volver a reservar/encolar),
# pero el slot queda CERRANDO hasta que el agente limpie.
TransactWriteItems:
  Update  Key {PK:"SLOT", SK:"#00k"}
      UpdateExpression: SET estadoReserva=:cerrando, deseado=:off REMOVE ownerNick
      ConditionExpression: #own = :sid AND estadoReserva = :reservado
  Update  Key {PK:"USER#<sid>", SK:"PROFILE"}
      UpdateExpression: REMOVE slotActual
      ConditionExpression: slotActual = :idx

# Fase 2 — el agente reconcilia: para l4d2@k, borra el admin por-servidor, y libera el slot.
UpdateItem  Key {PK:"SLOT", SK:"#00k"}
    UpdateExpression: SET estadoReserva=:libre, procesoEstado=:apagado REMOVE #own, vacioDesde
    ConditionExpression: estadoReserva = :cerrando
# → al pasar a LIBRE con cola pendiente, dispara la promoción §6.4
```

### 5.6 Por qué runtime y control-plane conviven en el mismo ítem de slot

El **agente** solo escribe atributos runtime (`procesoEstado, mapa, jugadores, bots, vacioDesde,
ultRuntime`) con `UpdateItem SET` sobre esos campos concretos; la **API** solo escribe
control-plane (`estadoReserva, deseado, owner, inicio, v`). Los conjuntos son **disjuntos** → no
hay lost-update real. El agente **nunca** condiciona sobre `estadoReserva` ni lo escribe (salvo la
liberación de Fase 2, que sí es condicional). Resultado: last-writer-wins por atributo, seguro, sin
transacción en el camino caliente del agente.

---

## 6. Quién lee/escribe qué (para el presupuesto de capacidad)

### 6.1 Front (SPA) — lecturas
- **Lista pública de slots (AP1)**: `Query PK=SLOT`, **consistencia eventual**. Poll ~8 s
  mientras la pestaña esté visible.
- **Mi estado**: `Query PK=USER#<sid>` (perfil+intent), eventual en poll; **fuerte** justo tras
  una mutación propia (o mejor: la API mutadora **devuelve el estado nuevo** en su respuesta y el
  front no re-lee — read-your-writes sin RCU extra).
- `CONFIG` (AP5): **cacheado** en la Lambda (60 s), no lo pega el front directo.

### 6.2 Agente (PC de casa) — por poll (~12 s)
- Lee: `HOST` (1) + `CONFIG` (1, cacheable) + `Query PK=SLOT` (1) + `Query PK=QUEUE Limit=1` (1)
  → ~3–4 lecturas eventuales pequeñas por poll.
- Escribe: **heartbeat** `HOST` (1 write **cada** poll) + runtime de slots **solo en cambio**
  (0–N writes) + liberación Fase 2 (rara).

### 6.3 Lambdas de API — por evento (raro)
- Reservar: `Query PK=SLOT` + `TransactWriteItems` (8 WCU) + posibles reintentos.
- Encolar: `UpdateItem` counter + `TransactWriteItems` (4 WCU).
- Salir de cola / cerrar server: `TransactWriteItems` (2 ítems → 4 WCU).
- Login Steam: upsert perfil (`UpdateItem`, 1 WCU).
- WoL: `UpdateItem` HOST + toma de `WOL_LOCK` (condicional).

### 6.4 Disparo de la promoción de cola
- **v1 (recomendado, sin Streams):** en la **Fase 2** de liberación, el agente llama un endpoint
  HTTPS `POST /api/slot-liberado {idx}`; la Lambda corre §5.4. Un solo camino, idempotente.
- Alternativa: **DynamoDB Streams** (`NEW_IMAGE`) filtrando `estadoReserva → LIBRE` que invoque
  la Lambda de promoción. Más "reactivo" pero añade Stream + Lambda; innecesario para el volumen.
  Se deja como opción, no se activa en v1 (evitar sobre-ingeniería).

---

## 7. TTL — qué expira (y qué NO)

`ttl` = epoch **segundos**. DynamoDB borra en un plazo **best-effort de hasta 48 h**, así que el
TTL es **solo backstop de limpieza**, nunca lógica de negocio con plazo exacto.

| Ítem | ¿TTL? | Valor | Por qué |
|---|---|---|---|
| `INTENT` | **Sí** | `creado + 60 min` | GC de arranques abandonados/colgados. El timeout *real* (p.ej. 3 min sin progreso → ERROR) lo dispara **EventBridge Scheduler**. |
| `HOST/WOL_LOCK` | **Sí** | `creado + 90 s` | Ventana de dedupe de magic packets; expira sola. |
| `USER/PROFILE` | No | — | Durable. |
| `SLOT/#k` | No | — | Durable (ítems de infraestructura). |
| `QUEUE/ENTRY#…` | **No** | — | Un TTL podría **sacar a alguien de la fila** silenciosamente. El abandono lo maneja la ventana de aceptación (Scheduler) al promover, no el TTL. |
| `CONFIG`, `HOST/STATE`, `COUNTER` | No | — | Durables/únicos. |

**Expiraciones precisas → EventBridge Scheduler** (no TTL): timeout de intent, ventana de
aceptación de cola (si se adopta el flujo con hold), reintentos escalonados de WoL, y reset diario
de `encendidosHoy`.

---

## 8. Consistencia — qué lecturas son fuertes

Regla general: **eventual por defecto**; fuerte solo donde importa. Los invariantes NO dependen de
lecturas fuertes: las **condiciones de escritura** (`ConditionExpression`) siempre evalúan contra
el dato comprometido más reciente, así que el claim/enqueue/free son seguros con lecturas previas
eventuales (se re-validan al escribir).

| Lectura | Consistencia | Motivo |
|---|---|---|
| Elegir slot candidato antes del claim | **Eventual** | Se re-valida con `estadoReserva=:libre` en la transacción; si está stale, la condición falla y se reintenta. |
| Lista pública de slots (AP1) | **Eventual** | Unos segundos de desfase son aceptables en la UI. |
| Posición en cola (AP8) | **Eventual** | Aproximación buena; la cola es corta. |
| `HOST` para decidir WoL | **Eventual** | Peor caso: un magic packet de más (idempotente, inocuo). El `WOL_LOCK` deduplica. |
| `CONFIG` | **Eventual** (cacheada) | El claim la re-valida con ConditionCheck dentro de la transacción. |
| Incremento del contador de cola | **Fuerte por naturaleza** | `UpdateItem ADD … ReturnValues=UPDATED_NEW` devuelve el valor comprometido; da orden total estricto. |
| Condiciones de `TransactWriteItems` / `UpdateItem` condicional | **Fuerte por naturaleza** | Es la garantía de atomicidad; no es una "lectura" configurable. |
| "Mi estado" **inmediatamente** tras mi propia mutación | **Fuerte** *(o mejor: sin re-lectura)* | Read-your-writes: preferible que la API mutadora **devuelva** el estado nuevo; si se re-lee, `GetItem`/`Query` con `ConsistentRead=true` para no mostrar "sin reserva" justo tras reservar. |

---

## 9. Encaje en el free tier (Provisioned 25 RCU / 25 WCU, sin GSIs)

Con **cero GSIs**, los 25 RCU + 25 WCU del free tier son **íntegros** para la tabla base
(el mínimo free-tier es agregado tabla+GSIs; sin GSIs no se reparte). Unidades: 1 RCU = 1 lectura
fuerte de 4 KB/s (2 eventuales); 1 WCU = 1 escritura de 1 KB/s. Todos los ítems aquí son < 1 KB.

**Escenario A — PC apagada (la mayor parte del tiempo).** Solo lecturas del front:
- 10 visitantes viendo la lista, poll 8 s → 10/8 ≈ 1.25 `Query PK=SLOT`/s. N≤6 ítems < 4 KB →
  0.5 RCU eventual c/u → **≈ 0.6 RCU/s**. `CONFIG` cacheada. **Writes ≈ 0.**
  → **≪ 25 RCU, ≈ 0 WCU.**

**Escenario B — PC arriba, una partida en curso, algunos mirando.**
- Agente: ~3.5 lecturas/poll ÷ 12 s ≈ 0.3 RCU/s; heartbeat 1 write/12 s ≈ 0.08 WCU/s + runtime
  en cambio (unas pocas/min) ≈ 0.1 WCU/s.
- Front: 15 mirando su estado + la lista, poll 6 s → ~2.5 req/s × ~0.5 RCU ≈ **1.3 RCU/s**.
- Mutaciones (reservar/encolar/cerrar): esporádicas; una reserva = 8 WCU **puntuales** (ráfaga
  absorbida por burst capacity), no sostenido.
  → **Sostenido ≈ 2 RCU/s y < 0.5 WCU/s.** Holgura > 10×.

**Conclusión:** cabe con muchísimo margen. **No** hace falta on-demand ni auto-scaling; provisioned
fijo 25/25 es lo correcto (predecible y gratis). Riesgo de throttling ≈ nulo; ante una ráfaga,
DynamoDB usa burst capacity y el SDK reintenta con backoff.

**Notas de costo:** `TransactWriteItems` = 2× WCU/ítem (reservas raras → despreciable). Los ítems
"calientes" de escritura (`HOST` heartbeat) están **separados** de `CONFIG` (lectura caliente) para
no cruzar contención. El heartbeat va a su propia partición (`HOST`), la lista a la suya (`SLOT`),
la cola a la suya (`QUEUE`) → sin hot-partition (el tráfico total es minúsculo, pero queda limpio).

---

## 10. Checklist de patrones de acceso → implementación

| # | Patrón de acceso | Operación | Claves / índice | Consistencia |
|---|---|---|---|---|
| AP1 | Listar los N slots con su estado | `Query` | `PK=SLOT` (asc por `idx`) | eventual |
| AP2 | Reserva activa de un usuario | `Query PK=USER#<sid>` → `slotActual`; luego `GetItem SLOT/#0k` | key | eventual (fuerte tras mutar) |
| AP3 | Perfil de usuario | `GetItem` | `PK=USER#<sid>, SK=PROFILE` | eventual |
| AP4 | Intent (arranque en curso) | `GetItem` / incluido en el `Query` de AP2 | `PK=USER#<sid>, SK=INTENT` | fuerte tras mutar |
| AP5 | Config global (N, interruptor) | `GetItem` cacheado | `PK=CONFIG, SK=GLOBAL` | eventual |
| AP6 | Heartbeat / estado del host | `GetItem` | `PK=HOST, SK=STATE` | eventual |
| AP7 | Encolar (FIFO) | `UpdateItem` counter + `TransactWriteItems` | `COUNTER/COLA`, `QUEUE`, `USER` | condicional |
| AP8 | Ver posición en cola | `Query … Select=COUNT` | `PK=QUEUE, SK < mySK` | eventual |
| AP9 | Promover al primero (head) | `Query Limit=1 asc` + `TransactWriteItems` (§5.4) | `PK=QUEUE` | condicional |
| AP10 | Salir de la cola | `TransactWriteItems` | `QUEUE`, `USER` | condicional |
| AP11 | Claim atómico de slot | `TransactWriteItems` (config+slot+user+intent) | `CONFIG`,`SLOT`,`USER` | condicional/fuerte |
| AP12 | Cerrar/liberar el propio server | `TransactWriteItems` (fase 1) + `UpdateItem` (fase 2, agente) | `SLOT`,`USER` | condicional |
| AP13 | Agente reporta runtime del slot | `UpdateItem` (solo en cambio, atributos runtime) | `PK=SLOT, SK=#0k` | LWW por atributo |
| AP14 | Agente heartbeat | `UpdateItem` | `PK=HOST, SK=STATE` | LWW |
| AP15 | Upsert de perfil en login Steam | `UpdateItem` (SET nick/avatar, if_not_exists creado) | `PK=USER#<sid>, SK=PROFILE` | — |
| AP16 | (hook) Encolar premium saltando cola | igual que AP7 con `tier=0` | `QUEUE ENTRY#0#…` | condicional |

---

## 11. Ítems de "seed" (bootstrap de la tabla)

Al desplegar, sembrar:

- `CONFIG/GLOBAL` con `n=4, portBase=6032, reservasAbiertas=true` y los timers de §4.1.
- `COUNTER/COLA` con `seqActual=0`.
- `HOST/STATE` con `estado="APAGADA", ultHeartbeat=0`.
- `SLOT/#001..#004` en `LIBRE` (`deseado=APAGADO, procesoEstado=APAGADO`).
- El operador: tras su primer login Steam, poner `operador=true` a mano en su `PROFILE`.

Todo con `PutItem` idempotente (`ConditionExpression: attribute_not_exists(PK)`), p.ej. desde un
custom resource de CDK o un script de bootstrap.

---

## 12. Lo que deliberadamente NO se modela (anti-sobre-ingeniería)

- **Bans / SourceBans**: viven en la **MySQL local** (D12/D16). Aquí solo `sourcebansUltUso` como
  sostén de auto-apagado.
- **Sesiones**: JWT stateless firmado por el backend (D4). No hay ítems de sesión.
- **Cola de comandos del agente**: reemplazada por reconciliación desired-state (§0.4).
- **Historial / auditoría / métricas**: el monitoreo ya existe local (Prometheus/Grafana/Loki).
  No se duplica en DynamoDB.
- **Materializar posiciones de cola**: se calcula por COUNT (evita O(n) writes).
- **GSIs**: ninguno necesario (§3).
- **Multi-juego / multi-host**: fuera de alcance (D9); `HOST` es un ítem único a propósito.
```
