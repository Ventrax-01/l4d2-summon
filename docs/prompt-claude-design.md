# Prompt para Claude Design — UI de "L4D2 Panel"

> Copia todo lo que sigue (desde "## BRIEF" hasta el final) y pégalo en Claude Design.

---

## BRIEF

Diseña la interfaz de una **plataforma web para reservar servidores de videojuego bajo demanda**. Un
usuario entra, inicia sesión y con **un solo botón reserva un servidor para jugar al instante**. Los
servidores corren en hardware que se enciende solo cuando alguien reserva y se apaga solo cuando nadie
lo usa, pero **el usuario nunca ve nada de infraestructura**: para él, reservar es pulsar un botón y
esperar una barra de progreso hasta que su servidor está listo.

Necesito el **diseño visual completo de todas las pantallas y sus estados**. A continuación describo
con detalle **qué hace cada pantalla, sus estados y sus flujos**. Tú decides la estética dentro de la
única restricción visual indicada. No cambies la funcionalidad ni inventes features que no estén aquí.

---

## RESTRICCIÓN VISUAL (la única)

- **Tema oscuro.**
- Estética de **plataforma gamer/tech moderna, limpia y profesional**, tipo panel de hosting o
  dashboard de gaming actual.
- **PROHIBIDO cualquier tema de zombies, terror, apocalipsis, sangre, infectados o supervivencia.**
  Nada de estética "survival horror". El nombre del juego si puede aparecer o insinuarse (Left 4 Dead 2, l4d2). Piensa en un
  producto SaaS de gaming neutro y pulcro, no en un mod de terror.
- Todo lo demás (paleta concreta, tipografías, formas, iconografía, motion) queda a tu criterio dentro
  de ese marco.

---

## PRINCIPIO DE PRODUCTO (guía toda la UI)

1. **La acción primaria de todo el producto es "Reservar servidor".** Debe ser el elemento más
   evidente y deseable de la interfaz. Cada pantalla tiene **un único CTA primario claro**.
2. **El usuario nunca ve infraestructura.** No existen las palabras "PC", "encender", "hardware",
   "Wake-on-LAN", "máquina", "boot", "SSH". La espera se comunica siempre como "preparando tu
   servidor".
3. **La espera es una barra de progreso por etapas (stepper), no un spinner infinito ni un
   cronómetro exacto.** Hay exactamente **dos duraciones posibles** y el diseño debe soportar ambas:
   - **Rápida (~45 segundos):** 3 etapas → **Iniciando → Verificando → ¡Listo!**
   - **Larga (~3 minutos):** 4 etapas → **Despertando → Iniciando → Verificando → ¡Listo!**
   - **NO existe una espera "instantánea" (~5 s).** Reservar SIEMPRE muestra el stepper. Nunca
     entregues un servidor "al toque" sin pasar por él.
   - El usuario ve el progreso por etapas, no un contador de segundos preciso.
4. **Mobile-first.** Diseña primero para móvil; el desktop es una ampliación ordenada.
5. Copy en **español**, tono **gamer cercano pero NEUTRO** (sin jerga del juego, sin referencias a
   zombies ni al título). Cercano y motivador, no infantil.
6. **Accesibilidad básica:** contraste suficiente en tema oscuro, foco visible, área táctil cómoda,
   los estados no se comunican solo por color (usa icono/etiqueta además del color).

---

## PANTALLAS Y ESTADOS (esto es lo importante — sé exhaustivo)

### 1. Login

- Pantalla mínima con un **único botón: "Entrar con Steam"** (login social; es el único método de
  acceso, no hay email ni contraseña, no hay formulario de registro).
- Mensaje breve de bienvenida y una línea que explique el producto en una frase ("Reserva un servidor
  y juega al instante").
- **Registro abierto:** cualquiera con cuenta de Steam entra; el mismo botón sirve para nuevos y
  recurrentes (no hay pantalla de "crear cuenta" separada).
- Estados: normal, botón en carga (redirigiendo a Steam), y estado de error ("no pudimos iniciar
  sesión, reintenta").

### 2. Home pública — lista de servidores (pantalla central del producto)

Es la vista que ve todo el mundo, **con o sin sesión iniciada**.

- Encabezado con la marca del panel, y si hay sesión: avatar + nick del usuario y acceso a perfil. Si
  no hay sesión: botón "Entrar con Steam".
- **CTA primario "Reservar servidor"** bien visible (si no hay sesión, al pulsarlo lleva a login).
- **Rejilla de tarjetas de servidor.** El número de servidores es **DINÁMICO y configurable**
  (arranca en 4 pero puede ser cualquier valor). **La rejilla debe verse bien con entre 1 y 8
  tarjetas** — diséñala responsiva para 1, 2, 3, 4, 5, 6, 7 y 8 servidores sin romperse, en móvil y
  desktop. No asumas un número fijo.
- Un contador/indicador de cuántos servidores están libres vs. ocupados.
- **Estados de cada tarjeta de servidor** (diséñalos todos, bien diferenciados y accesibles):
  - **Libre:** disponible. Muestra que se puede reservar. Es el estado más "invitador".
  - **Iniciando / preparándose:** alguien lo está reservando ahora mismo; muestra que está arrancando
    (indeterminado, no dueño aún).
  - **Activo (ocupado):** muestra **dueño** (nick/avatar de quien lo reservó), **mapa actual**,
    **jugadores conectados** (ej. "3/8"), y un botón para **entrar a jugar** (los servidores son
    públicos, ver reglas). Tiempo activo opcional.
  - **Error:** el servidor no pudo prepararse o no responde; mensaje corto y neutro.
  - (Opcional, si aporta) **reservado para cola:** un slot que acaba de liberarse y está esperando a
    que el siguiente en la cola entre.
- Nota persistente y amable de que **los servidores se apagan solos cuando nadie juega** (ver reglas
  visibles); comunícalo como algo **normal y bueno**, no como una falla.

### 3. Flujo de reserva — el Stepper

Al pulsar "Reservar servidor" (con sesión), se entra al flujo de preparación.

- **Stepper con las etapas** según la duración (3 o 4 etapas, ver principio 3). Cada etapa tiene
  nombre y un micro-copy motivador y NEUTRO (nada de infraestructura):
  - **Despertando** (solo en el flujo largo): "Encendiendo tu servidor…"
  - **Iniciando:** "Arrancando y cargando el mapa…"
  - **Verificando:** "Comprobando que todo responde y dándote tus permisos…"
  - **¡Listo!**
- La etapa actual se destaca; las completadas y las pendientes se distinguen visualmente.
- El usuario **puede salir de esta pantalla y volver**; la reserva sigue viva. Considera un estado
  "reanudando" al volver.
- Estado de **error dentro del stepper:** si la preparación falla, mensaje honesto y neutro + botón
  **"Reintentar"** + enlace secundario **"Avisar al operador"**. Nunca culpes al usuario.
- Debe funcionar visualmente igual con 3 y con 4 etapas.

### 4. Pantalla "¡Listo!" (servidor entregado)

Es el momento de éxito; que se sienta como una recompensa.

- Confirmación clara de que **el servidor está arriba y es suyo**.
- **CTA primario: botón grande "Conectar"** (abre el juego directamente vía enlace `steam://connect`).
- **Dirección de conexión copiable:** una línea tipo `conectar IP:puerto` con botón de **copiar** (para
  quien prefiera pegarla manualmente o compartirla). Debe verse claramente que se puede copiar y dar
  feedback de "copiado".
- **Chuleta de administrador in-game:** un bloque compacto que explique que, como reservó el servidor,
  **es admin de ESE servidor** y puede: **expulsar (kick), cambiar de mapa y controlar la partida**.
  **Debe dejar claro que NO puede banear.** Preséntalo como una lista corta y escaneable de comandos o
  acciones disponibles.
- Recordatorio de que el servidor es **público** (cualquiera puede entrar con la dirección) y de que
  **se cerrará solo si queda vacío un rato**.
- Acceso a "Mi servidor" y opción de **cerrar el servidor**.

### 5. Cola de espera

Cuando todos los servidores están ocupados, el usuario que reserva entra a una **cola FIFO**.

- Estado **"En cola":** muestra la **posición** del usuario ("Estás #3 en la cola"), cuántos esperan,
  y un mensaje tranquilizador. CTA/acción secundaria para **salir de la cola**.
- Estado **"¡Es tu turno!":** cuando se libera un servidor y le toca, un aviso destacado con:
  - Que tiene un servidor reservado para él.
  - Un **tiempo límite para entrar** (cuenta regresiva de unos minutos para reclamar el turno; si no
    entra a tiempo, pasa al siguiente y él vuelve/sale).
  - **CTA primario "Entrar ahora"** (que lo lleva al stepper de reserva, versión rápida ~45s).
- El aviso de turno debe ser imposible de perder de vista (es sensible al tiempo). Considera cómo se
  ve si el usuario tenía la pestaña en segundo plano y vuelve.

### 6. "Mi servidor"

Vista del servidor que el usuario tiene reservado ahora mismo (solo puede tener **uno a la vez**).

- Estado actual del servidor (activo, vacío, cerrándose), mapa, jugadores conectados.
- Botón **"Conectar"** y la **dirección copiable** (como en la pantalla Listo).
- Acceso a la **chuleta de admin** (kick / cambiar mapa / controlar partida; sin ban).
- **CTA para cerrar el servidor** (con confirmación, ya que libera el slot para la cola).
- Estado cuando no tiene ningún servidor: vacío con CTA "Reservar servidor".

### 7. Perfil

- Datos que vienen de Steam: **avatar, nick y SteamID**. Son de solo lectura (no se editan aquí).
- Indicador de si tiene una reserva activa o un lugar en cola, con acceso rápido a ellos.
- **Botón "Cerrar sesión".**
- Mantén esta pantalla simple; no hay ajustes de cuenta complejos.

### 8. Estados transversales (diséñalos como piezas reutilizables)

- **Estado vacío:** cuando no hay servidores que mostrar, o el usuario no tiene reservas/cola. Con
  ilustración/icono neutro y un CTA claro.
- **Estado de carga:** skeletons o placeholders para la lista de servidores y para el perfil mientras
  cargan los datos (evita saltos de layout).
- **Estado de error de una sección:** un servidor o la lista no cargó; mensaje corto + botón
  "Reintentar".
- **Página global "Backend caído":** una pantalla de fallback para cuando el servicio web no responde
  en absoluto. Neutra, honesta, con opción de reintentar. (Es distinta del stepper de reserva y de un
  error de tarjeta: aquí no carga NADA.)
- **Toasts/avisos** para acciones puntuales (copiado al portapapeles, "saliste de la cola",
  "servidor cerrado", errores de límite tipo "espera unos segundos antes de reservar de nuevo").

---

## REGLAS DEL PRODUCTO QUE DEBEN SER VISIBLES EN LA UI

Comunícalas con copy claro y neutro, integradas naturalmente (no como un muro de texto legal):

- **1 servidor por usuario a la vez.** Para abrir otro, primero cierra el suyo.
- **Servidores públicos:** quien reserva abre el servidor para todos; **cualquiera puede entrar** con
  la dirección de conexión.
- **Los servidores se apagan/duermen solos** cuando nadie juega. Es normal y esperado; comunícalo con
  naturalidad ("tu servidor se cierra solo si queda vacío un rato").
- **Registro/acceso abierto con Steam:** cualquiera con cuenta de Steam puede entrar y jugar.
- **Quien reserva es admin de su servidor** con poderes limitados: kick, cambiar mapa, controlar la
  partida; **sin ban**.

---

## LO QUE NO DEBES INCLUIR

- **Nada de temática zombie / terror / apocalipsis / sangre** (restricción dura).
- **Ninguna referencia visible a infraestructura** (encendido de máquinas, IPs internas, estados de
  hardware, agentes, etc.). El usuario solo ve "su servidor" y un progreso.
- **No incluyas un panel de administración/operador ni el panel de baneos (SourceBans):** eso es una
  herramienta separada, exclusiva del operador, y **no forma parte de esta UI**.
- **No incluyas planes de pago, precios, suscripciones ni "premium".** No existen en esta versión.
- No inventes pantallas de configuración, estadísticas avanzadas, chat, amigos, ni features que no
  estén listadas arriba.

---

## ENTREGABLE ESPERADO

Diseña, en tema oscuro y estética gamer/tech neutra:

1. **Login.**
2. **Home pública / lista de servidores**, mostrando la rejilla con **varios conteos (al menos 1, 4 y
   8 tarjetas)** y **todos los estados de tarjeta** (libre, iniciando, activo con dueño+jugadores+mapa,
   error).
3. **Stepper de reserva** en sus **dos variantes** (3 etapas ~45s y 4 etapas ~3min), incluyendo el
   **estado de error con Reintentar**.
4. **Pantalla "¡Listo!"** con Conectar, dirección copiable y chuleta de admin (sin ban).
5. **Cola de espera** en sus dos estados ("En cola con posición" y "¡Es tu turno!" con cuenta regresiva
   y CTA "Entrar ahora").
6. **"Mi servidor".**
7. **Perfil.**
8. **Estados transversales:** vacío, carga (skeletons), error de sección, y **página global "backend
   caído"**, más ejemplos de **toasts**.

Para cada pantalla: **un CTA primario claro**, jerarquía visual limpia, y consistencia entre todas.
Mobile-first, con nota de cómo escala a desktop. Copy final en español, tono gamer cercano y neutro.
