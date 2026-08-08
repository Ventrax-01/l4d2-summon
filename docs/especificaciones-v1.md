# L4D2 Panel — Especificaciones v1

> Plataforma web para reservar servidores de Left 4 Dead 2 bajo demanda, hospedados en la PC
> local de Ventrax (que se enciende sola por Wake-on-LAN y se apaga sola al quedar ociosa).
> Dominio: **l4d2.ventrax.dev**. Estado: **especificación** (no se ha construido nada aún).

Este documento reemplaza cualquier planteamiento anterior (el proyecto previo "ventrax-servers"
queda descartado). Las decisiones de abajo son las acordadas explícitamente con el usuario.

---

## 1. Visión

Una comunidad abierta de jugadores entra a `l4d2.ventrax.dev`, inicia sesión con Steam y
**reserva un servidor para jugar al instante**. La carga de juego corre en la PC de casa de
Ventrax, que **normalmente está apagada**: al reservar, si hace falta, el sistema la enciende,
levanta el servidor y se lo entrega al jugador **con él como admin in-game**. Cuando ya no se
usa nada, la PC se apaga sola. La web (front y back) vive en AWS serverless para que el costo
sea prácticamente nulo con tráfico mínimo.

## 2. Actores

| Actor | Quién | Qué puede |
|---|---|---|
| **Jugador** | Cualquiera, tras entrar con Steam | Reservar 1 servidor, ser admin in-game de ese servidor, entrar a cualquier servidor abierto, ponerse en cola |
| **Visitante** | Sin sesión | Ver la lista de servidores y su estado; entrar a jugar a uno abierto (`steam://`). No puede reservar |
| **Operador** | Ventrax | Todo lo anterior + banear, gestionar SourceBans, configurar N, suspender usuarios. En v1 lo hace por DB/SSH + panel SourceBans; **no hay panel de operador propio todavía** |

Solo hay **dos roles**: jugador y operador. La plataforma de operador se construye después.

## 3. Decisiones cerradas (ADR)

| # | Decisión |
|---|---|
| D1 | **Reserva = bajo demanda** (jugar ahora). No hay reservas agendadas a futuro. |
| D2 | **Servidores públicos**: quien reserva abre el servidor para todos; cualquiera entra por `steam://connect`. |
| D3 | **Quien reserva es ADMIN in-game** de su servidor (kick, cambiar mapa, controlar match; **sin ban**). |
| D4 | **Autenticación: solo "Iniciar sesión con Steam"** (Steam OpenID 2.0). Sin email/contraseña, **sin Cognito**. El SteamID queda verificado por el propio login. |
| D5 | **Registro abierto al público** (cualquiera con cuenta de Steam). |
| D6 | **Tope de N servidores, configurable** por el operador. Arranca en **N=4** (a validar según lo que aguante la PC). |
| D7 | **1 servidor reservado por usuario a la vez.** Para abrir otro, cierra el suyo. |
| D8 | **Cola de espera**: si los N están ocupados, el usuario se anota y el sistema le entrega un servidor (o le avisa en la web) apenas se libere uno. |
| D9 | **Solo L4D2** (la flota ZoneMod existente). No se abstrae para multi-juego. |
| D10 | **PC normalmente apagada.** Se enciende por **Wake-on-LAN** al reservar (o al usar SourceBans). WoL ya verificado funcionando desde LAN e internet. |
| D11 | **Auto-apagado inmediato**: la PC se apaga apenas no queda **nada que la mantenga viva** (ver §7). Cada servidor vacío se cierra tras **15 min**. |
| D12 | **Bans**: solo el **anticheat LAC (automático)** y el **operador**. Persisten en una **MySQL local con SourceBans++**. |
| D13 | **Panel SourceBans++** hospedado en **`l4d2.ventrax.dev/sourcebans`**, servido desde la PC local, con **wake-on-uso restringido al operador** (ver §9). |
| D14 | **Front en CloudFront + S3**, **back en Lambda** (Function URLs), datos en **DynamoDB**. Objetivo de costo ~$0. |
| D15 | **Planes de pago: fuera de v1.** El modelo de datos deja el hueco (ej. un flag para saltarse la cola en el futuro). |
| D16 | **Registro de IPs / detección de multicuentas: fuera de alcance por ahora.** La MySQL local es **solo para SourceBans**. |
| D17 | **Panel de operador: después.** En v1 el operador gestiona por DB/SSH + SourceBans. |

## 4. Alcance

**Dentro de v1:** login con Steam · lista de servidores en vivo (pública) · reservar bajo demanda
con encendido automático de la PC · ser admin in-game · cola de espera · cerrar el propio servidor ·
auto-apagado · SourceBans++ local con wake-on-uso · bans por LAC + operador · N configurable.

**Fuera de v1:** reservas agendadas · planes de pago/premium · registro de IPs y detección de
multicuentas · panel de operador propio · multi-juego · notificaciones por email/push · co-admins.

## 5. Arquitectura

```
                          Cloudflare/Route53 DNS (l4d2.ventrax.dev)
                                        │ TLS (ACM, us-east-1)
                        ┌───────────────▼────────────────────────────┐
   Navegador ─────────► │  CloudFront                                 │
   (jugador/operador)   │   /*           → S3 (SPA, siempre viva)     │
                        │   /api/*       → Lambda (Function URL)      │
                        │   /auth/steam* → Lambda (login Steam)       │
                        │   /sourcebans* → ORIGEN = PC de casa (DDNS) │
                        └───────┬─────────────────┬───────────────────┘
                                │                 │
                    ┌───────────▼──────┐   ┌───────▼─────────────────────────┐
                    │ Lambdas (API)    │   │ PC de casa (normalmente APAGADA)│
                    │  - estado flota  │   │  - flota L4D2 ZoneMod (l4d2@1..N)│
                    │  - reservar      │   │  - MySQL (SourceBans++)          │
                    │  - cola          │   │  - panel SourceBans (PHP)        │
                    │  - login Steam   │   │  - AGENTE (polling saliente)     │
                    │  - WoL (UDP)     │   └───────▲─────────────────────────┘
                    └───────┬──────────┘           │ WoL (magic packet UDP)
                            │                       │ + polling HTTPS del agente
                    ┌───────▼──────────┐            │
                    │ DynamoDB         │◄───────────┘
                    │ (usuarios,       │  el agente reporta estado y toma comandos
                    │  servidores,     │
                    │  cola, config)   │
                    └──────────────────┘
```

- **La SPA (CloudFront/S3) está siempre disponible**, aunque la PC esté apagada: así el jugador
  siempre puede ver el estado y disparar una reserva (que enciende la PC).
- **El agente en la PC hace polling HTTPS saliente** (cada ~10-15s): reporta heartbeat + estado de
  los servidores y recoge comandos pendientes (levantar/cerrar servidor, apagar). No abre puertos
  entrantes nuevos.
- **`/sourcebans` es la única ruta que sale de la nube hacia la PC** (origen custom vía un hostname
  de DNS dinámico, porque la IP de casa cambia).

## 6. Autenticación (Steam OpenID, sin Cognito)

- Botón único **"Iniciar sesión con Steam"** → flujo Steam OpenID 2.0.
- Una Lambda (`/auth/steam/*`) inicia el flujo y valida el retorno de Steam; de ahí obtiene el
  **SteamID64 verificado**.
- La Lambda crea/actualiza el usuario en DynamoDB y emite un **token de sesión propio** (JWT
  firmado por el backend), guardado en el cliente. No hay contraseñas ni Cognito.
- El SteamID **es** la identidad, así que el admin in-game sale directo y verificado (nadie puede
  suplantar el SteamID de otro).
- El operador es un usuario normal con un **flag `operador`** en DynamoDB (seteado a mano).

## 7. Encendido y apagado de la PC

**Encendido (Wake-on-LAN):** una Lambda arma el magic packet y lo envía por UDP a la IP pública de
casa (MAC `0A:E0:AF:AF:28:22`). Se dispara al reservar con la PC apagada, o al operador entrar a
SourceBans. Reintentos escalonados hasta que el agente reporta heartbeat. Respetar el **timing**:
al apagar, la NIC tarda ~15-30s en quedar en modo WoL; el diseño no asume que un paquete enviado
demasiado pronto despierte.

**Apagado — la PC se apaga cuando NO queda ningún "sostén":**
Sostenes que mantienen la PC viva:
1. Algún servidor con jugadores, o vacío hace menos de 15 min.
2. Una reserva/encendido en curso (intent activo).
3. **SourceBans usado en los últimos 10 min.**
4. Una sesión SSH activa del operador.

Cuando **ninguno** aplica → `poweroff` limpio (el agente para las units y apaga). Como cada
servidor ya espera sus 15 min de vacío antes de cerrarse, "apagar al instante cuando todo está
cerrado" no produce flapping.

## 8. Flujo de reserva (bajo demanda)

El jugador pulsa **"Reservar servidor"**. El backend crea un *intent* con máquina de estados y la
SPA muestra un stepper. Casos:

- **Hay un slot libre y la PC está encendida** (~30-45s): el agente levanta `l4d2@k`, siembra al
  jugador como admin, verifica que responde (A2S + plugins), y entrega el `steam://connect`.
- **Hay slot libre pero la PC está apagada** (~3 min): WoL → boot → agente sube → levanta el
  servidor → verifica → entrega. El stepper muestra las etapas (DESPERTANDO → INICIANDO →
  VERIFICANDO → LISTO) sin mencionar "PC/infraestructura".
- **Los N están ocupados** → el jugador entra a la **cola** (§10).

Reglas: 1 servidor por usuario (D7). El jugador puede salir de la página y volver; el intent sigue
vivo. Si dos personas piden a la vez, convergen (no error). Si el arranque falla, mensaje honesto +
reintento + "avisar al operador".

**Admin in-game:** como `admins_simple.ini` es compartido por toda la flota, se usará un mecanismo
por-servidor (plugin/archivo por puerto) para dar admin al reservador **solo en su servidor**, que
se limpia al cerrarse/reciclarse. (Detalle técnico a resolver en el diseño; hoy la flota no lo tiene.)

## 9. SourceBans (`l4d2.ventrax.dev/sourcebans`)

- **MySQL/MariaDB local** en la PC (provisionada por Ansible), con **SourceBans++**. Los bans de LAC
  (`lilac_sourcebans 1`) y del operador por fin **persisten** — esto corrige el bug actual (hoy LAC
  banea a la nada porque no existe la DB).
- **Panel PHP de SourceBans++** servido desde la PC. CloudFront enruta `/sourcebans/*` al origen de
  casa (DDNS).
- **Wake-on-uso (solo operador):** si la PC está apagada y el operador (sesión Steam con flag
  `operador`) entra a `/sourcebans`, se dispara el mismo WoL que una reserva; una página
  "despertando…" hace polling y luego lo mete al panel. El uso de SourceBans mantiene la PC viva
  (sostén #3 de §7); 10 min sin uso → se apaga si no hay nada más.
- **Guardarraíl:** el wake por `/sourcebans` es **exclusivo del operador**; un visitante no puede
  usar esa URL para encender la PC.
- Consecuencia aceptada: el panel **solo funciona con la PC encendida** (necesita la MySQL local).

## 10. Cola de espera

- Al no haber slots, el usuario se anota en una cola (FIFO) persistida en DynamoDB.
- Cuando un servidor se libera, el primero de la cola recibe su servidor (o un aviso en la web con
  unos minutos reservados para entrar). Aviso **en la web** (pestaña abierta) en v1; email en v2.
- La cola cuenta como actividad que puede mantener la PC viva mientras haya gente esperando y
  servidores por liberarse.

## 11. Anticheat y bans

- **LAC (Little Anti-Cheat)** sigue detectando trampas y ahora **banea de verdad** vía SourceBans.
- El **operador** banea desde el panel SourceBans o in-game.
- El **reservador NO puede banear** (solo kick/mapa/match).

## 12. Modelo de datos (bosquejo, DynamoDB single-table)

Entidades: `Usuario` (SteamID64, nick, avatar, flag operador, flag suspendido, creado) ·
`Config` (N actual, interruptor global de reservas) · `Servidor/Slot` (índice, estado, dueño,
inicio, mapa, jugadores) · `Intent` (reserva en curso, máquina de estados, etapa) · `Cola`
(posición, usuario, timestamp) · `Host` (estado PC, último heartbeat, IP pública actual).
Bans **no** van aquí: viven en la MySQL local (SourceBans). Detalle de claves/GSI en el diseño
técnico posterior.

## 13. Infra AWS y costo

- **S3 + CloudFront** (SPA, ruta API, ruta /sourcebans a origen de casa), **Lambda Function URLs**
  (API, login Steam, WoL), **DynamoDB provisioned 25/25** (free tier), **EventBridge Scheduler**
  (reintentos de WoL, expiración de intents/cola), **CloudWatch Logs** (retención corta).
- **Sin Cognito** (login propio con Steam). **Sin API Gateway, sin VPC/NAT.**
- **Costo esperado: ~$0.01–0.20/mes** (S3 cobra desde el primer byte; lo demás cae en free tier
  permanente). Alarma de presupuesto de $1. La zona DNS ya se paga aparte (~$0.50/mes).

## 14. Componente local (PC de casa)

Provisionado por Ansible (extiende la flota `l4d2-fleet` existente):
- Flota L4D2 ZoneMod `l4d2@1..N` (ya existe).
- **MySQL/MariaDB + SourceBans++** (nuevo) + su panel PHP.
- **Agente** (nuevo): polling saliente a la nube, ejecuta comandos (levantar/cerrar servidor,
  poweroff), reporta estado, aplica la lógica de auto-apagado con sus sostenes, y siembra el admin
  por-servidor. Corre como servicio con permisos acotados (no root).
- DNS dinámico para que CloudFront alcance `/sourcebans` pese al IP cambiante.

## 15. Seguridad y abuso

- El botón "reservar" **enciende físicamente la PC** → límites de uso: N tope, 1 por usuario, tope
  de encendidos por día, cooldown entre operaciones, interruptor global de reservas.
- Suspensión de usuarios: flag `suspendido` que la API respeta (moderación mínima de v1).
- SteamID verificado por el login (no suplantable).
- `/sourcebans` expuesto: HTTPS, login propio de SourceBans, y wake solo-operador.
- Aviso: reservar implica encender hardware de una persona; se comunica en la UI.

## 16. Riesgos y pendientes

- **Capacidad de la PC:** medir cuántas instancias L4D2 aguanta antes de fijar N.
- **Admin por-servidor:** la flota hoy tiene admin global; hace falta el mecanismo por-puerto.
- **Churn de matchmode de ZoneMod:** `!match`/`!unmatch` a veces se traban en servidores vacíos
  (candado de confogl + timers congelados por hibernación). A resolver con un watchdog; el agente
  puede encargarse.
- **WoL:** verificado, pero conviene una prueba limpia desde internet tras el arreglo de booteo.
- **CloudFront → origen de casa** (DDNS, IP cambiante, PC a veces apagada): definir el manejo de
  errores de origen y el certificado del lado de casa.
