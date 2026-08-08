# Handoff: Ventrax — Plataforma de reserva de servidores L4D2

## Overview
Interfaz web para reservar servidores de Left 4 Dead 2 bajo demanda. El usuario entra con Steam, pulsa "Reservar servidor", ve un stepper de preparación por etapas y recibe un servidor listo con dirección de conexión (`steam://connect`). Incluye cola FIFO cuando todo está ocupado, vista "Mi servidor", perfil y estados transversales (carga, error, backend caído, toasts).

Principios de producto (obligatorios en la implementación):
- La acción primaria de TODO el producto es "Reservar servidor". Un único CTA primario por pantalla.
- El usuario NUNCA ve infraestructura. Prohibido: "PC", "encender", "hardware", "Wake-on-LAN", "máquina", "boot", "SSH". La espera siempre se comunica como "preparando tu servidor".
- La espera es un stepper por etapas, nunca spinner infinito ni cronómetro exacto. Dos variantes: rápida ~45 s (3 etapas) y larga ~3 min (4 etapas). No existe entrega instantánea sin stepper.
- Mobile-first. Copy en español, tono gamer cercano pero neutro. Sin temática zombie/terror.
- Accesibilidad: los estados nunca se comunican solo por color (siempre color + icono/punto + etiqueta de texto), foco visible, hit targets ≥44px en móvil.

## About the Design Files
Los archivos de este paquete son **referencias de diseño creadas en HTML** (prototipos que muestran el aspecto y el comportamiento previstos), no código de producción para copiar tal cual. La tarea es **recrear estos diseños en el entorno del codebase destino** (React, Vue, etc.) usando sus patrones y librerías existentes — o, si aún no existe entorno, elegir el framework más apropiado e implementarlos ahí.

- `Prototipo.dc.html` — prototipo interactivo con todos los flujos. El HTML dentro de `<x-dc>` usa un sistema de plantillas propio (`sc-if`, `sc-for`, `{{ holes }}`) y una clase `Component` con la lógica de estados: úsalo como especificación de markup, estilos y máquina de estados.
- `Board de Diseño.dc.html` — board estático con todas las pantallas y estados, móvil y desktop, organizados por secciones numeradas.

## Fidelity
**High-fidelity.** Colores, tipografía, espaciados, copy e interacciones son finales. Recrear pixel-perfect con las librerías del codebase.

## Design Tokens

Colores:
- Fondo base: `#101114` · Fondo tarjeta/superficie: `#15181E` · Superficie hundida (code/skeleton): `#0B0C0F` / `#1B1F27`
- Bordes: `#262A33` (neutro), `#1E222A` (divisores), `#333945` (botón secundario), `#1E2630` (cajas informativas)
- Texto: primario `#F2F4F8`, secundario `#C7CEDA`, muted `#9AA3B2`, sutil `#8A94A6`, deshabilitado `#5B6675` / `#6E7787`
- Acento primario (CTA, en juego): `#28D8FF` — texto sobre acento: `#06212B`
- Estados: libre `#3DDC91` · preparando `#FFB224` · error `#FF5C5C` (texto claro `#FFB3B3`, `#FF8A8A`) · reservado/cola `#8B7CFF`
- Chips: fondo `rgba(color,.1–.12)` + borde `rgba(color,.35–.4)`; sobre imagen usar fondos oscuros `rgba(9,42,52,.85)` (cian), `rgba(10,36,24,.85)` (verde), `rgba(42,32,9,.85)` (ámbar)
- Glow del CTA: `box-shadow: 0 0 28px rgba(40,216,255,.2)` (hover `.35–.4`)

Tipografía (Google Fonts):
- Titulares/datos/botones: **Outfit** (500–800). Marca: 800, letter-spacing .04–.05em. Chips: 700 9–11px, letter-spacing .12–.16em, MAYÚSCULAS.
- Cuerpo: **Source Sans 3** (400–700), 12.5–14px, line-height 1.45–1.6.
- Direcciones de conexión: monospace (`ui-monospace, Menlo`), color `#8FD4EC`.

Formas y espaciado:
- Radios: 3px (chips/logo), 4px (botones, inputs, cajas), 5–6px (tarjetas), 8px (tarjetas "cómo funciona"), 50% (avatares/badges).
- Alturas de botón: CTA principal 56–60px; secundario 44–48px; pequeño 36–40px.
- Contenido centrado a max-width 1040px (home) / 560px (vistas de una columna); padding lateral 20–24px móvil, 40–80px desktop.
- Fondo de la home: gradiente radial cian tenue arriba + retícula de líneas de 48px a `rgba(255,255,255,.015)`.

Animaciones (keyframes):
- `vxPulse`: opacity 1→.35→1, 1.2–1.6s infinite (puntos de estado, badge "es tu turno").
- `vxShimmer`: barrido de gradiente 200%, 1.4s linear infinite (skeletons).
- `vxBar`: barra indeterminada translateX(-100%→260%), ancho 40%, 1.6s ease-in-out infinite (preparando).
- `vxSpin`: rotación 0.8–0.9s linear infinite (spinner login/reanudando).
- `vxToast`: entrada translateY(12px)+fade, .25s. `vxPop`: scale(.85→1)+fade, .25–.4s (modal, pantalla listo).

## Screens / Views

### 1. Login
- Centrado vertical: logo V (56px, cian, radio 6), "VENTRAX" 26px/800, subtítulo "L4D2 SERVERS" 11px letter-spacing .28em, frase "Reserva un servidor y juega al instante."
- CTA único "Entrar con Steam" (56px, cian, icono Steam) + nota "Acceso abierto: cualquiera con cuenta de Steam entra y juega."
- Estados: normal · cargando (botón deshabilitado `#1E5F73` con spinner y "Conectando con Steam…") · error (caja roja "No pudimos iniciar sesión con Steam. Vuelve a intentarlo." + botón "Reintentar con Steam").
- No hay email/contraseña ni registro separado.

### 2. Home (pública, con o sin sesión)
- Header sticky (blur): logo+marca a la izquierda (clic → home); a la derecha: con sesión → accesos rápidos contextuales ("Mi servidor" pulsante si hay reserva; "Cola #N" si está en cola) + nick y avatar (clic → perfil); sin sesión → botón "Entrar con Steam".
- Hero: caja `rgba(21,24,30,.88)`, título "Reserva y juega en minutos", subtítulo "Pulsa el botón, espera la preparación y conéctate. Sin configurar nada.", contadores grandes (LIBRES verde / PREPARANDO ámbar / EN JUEGO cian) y CTA "⚡ Reservar servidor" a la derecha (58px). Sin sesión añade "Te pediremos entrar con Steam primero."
- Rejilla: `grid-template-columns: repeat(auto-fill, minmax(280px,1fr))`, gap 14–16px. Debe verse bien con 1–8 tarjetas (nº dinámico).
- Tarjeta de servidor, estados:
  - **Libre**: miniatura del mapa atenuada (overlay `rgba(16,17,20,.5)`) con "Próximo mapa · {mapa}", chip verde LIBRE, "👥 0/8" gris, texto "Disponible — resérvalo y juega.", botón outline verde "Reservar este" (reserva ese servidor).
  - **Preparando**: miniatura con overlay `.3`, chip ámbar PREPARANDO (punto pulsante), "Alguien lo está reservando ahora mismo…", barra indeterminada ámbar. Sin dueño visible.
  - **Activo**: miniatura del mapa, chip cian EN JUEGO, nombre + "👥 3/8", dueño (avatar+nick+"· hace X min"), botón outline cian "Entrar a jugar" (`steam://connect/...`). Lleno (8/8): botón deshabilitado "Servidor lleno". Si es del usuario: badge cian "TUYO" y botón "Ir a Mi servidor"/"Ver progreso".
  - **Error**: sin miniatura, chip rojo "⚠ ERROR", "No pudo prepararse. Ya estamos en ello."
  - **Reservado (cola)**: chip violeta "⧗ RESERVADO", "Guardado para el siguiente de la cola."
- Miniaturas: imágenes por mapa servidas desde CDN (placeholder actual: gradiente + etiqueta "IMAGEN MAPA · CDN"). Mapas de ejemplo: Dead Center, The Parish, Dark Carnival, Hard Rain, Swamp Fever, No Mercy, The Passing, Cold Stream.
- Sección "CÓMO FUNCIONA": divisor con rótulo entre líneas; timeline vertical con espina central (línea degradada cian), badges circulares 1/2/3 (40px, borde cian, glow) y 3 tarjetas cuadradas (340px, radio 8, icono SVG cian 34px centrado verticalmente + texto) alternando izquierda→derecha→izquierda. Copy: "Reserva un servidor / Pulsa el botón y listo, no hay que configurar nada. Un servidor por persona." · "Espera a que arranque / Tarda unos minutos como mucho; te avisamos cuando esté listo." · "Conéctate con tu grupo / Comparte la dirección: cualquiera puede unirse. Tú mandas mientras juegas. Si queda vacío un rato, se cierra solo."
- Footer global en todas las pantallas: "Hecho con mucho café y amor, por Ventrax" (12px, `#5B6675`, centrado, anclado abajo).

### 3. Stepper de reserva
- Cabecera: badge "SERVIDOR #N · TUYO", título "Preparando tu servidor", intro ("Suele tardar unos minutos…" o "Menos de un minuto…") + "Puedes salir y volver: tu reserva sigue viva."
- Etapas — flujo largo (~3 min): Despertando ("Encendiendo tu servidor…") → Iniciando ("Arrancando y cargando el mapa…") → Verificando ("Comprobando que todo responde y dándote tus permisos…") → ¡Listo!. Flujo rápido (~45 s): sin Despertando. El mismo componente soporta 3 y 4 etapas.
- Estados visuales por etapa: hecha = círculo cian relleno con ✓ y línea cian; actual = anillo cian pulsante con glow + micro-copy + barra indeterminada; pendiente = círculo gris numerado; fallida = anillo rojo con "!".
- Layout: vertical en móvil/columna estrecha; horizontal con conectores en desktop ancho.
- Botón "Volver a la lista (la reserva sigue)" mientras corre. Al volver: estado "Reanudando tu reserva…" (spinner + texto) antes de repintar el progreso.
- Error: caja roja "No pudimos preparar tu servidor / Algo falló de nuestro lado; no es culpa tuya. Tu sitio no se pierde: reintenta cuando quieras." + CTA "Reintentar" + enlace "Avisar al operador". Nunca culpar al usuario.

### 4. ¡Listo!
- Check verde en círculo con glow (animación pop), "¡Tu servidor está listo!", "El Servidor #N está arriba y es tuyo. A jugar."
- CTA primario "▶ Conectar" (60px, abre `steam://connect/host:puerto`).
- Dirección copiable: `connect play.ventrax.gg:27015` en monospace + botón copiar 48px (icono ⧉→✓ 2 s) + toast "Dirección copiada". Nota: "Compártela: cualquiera puede entrar, el servidor es público."
- Chuleta admin (caja): "ERES ADMIN DE ESTE SERVIDOR" — ✓ Expulsar jugadores (kick) · ✓ Cambiar de mapa · ✓ Controlar la partida (reiniciar, pausar…) · ✕ Banear — eso no está en tus manos (en gris con ✕ rojo). El "sin ban" es obligatorio.
- Nota: "Tu servidor se cierra solo si queda vacío un rato. No tienes que hacer nada."
- Botones: "Ir a Mi servidor" + "Cerrar servidor" (rojo outline, abre confirmación).

### 5. Cola
- **En cola**: chip violeta "⧗ EN COLA", posición gigante "#3" (72px), "tu posición en la cola", texto tranquilizador con nº de personas esperando, "Puedes dejar esta pestaña de fondo, tu sitio se guarda." Acción: "Salir de la cola" (rojo outline) → toast "Saliste de la cola…".
- **¡Es tu turno!**: imposible de ignorar — badge cian pulsante "¡ES TU TURNO!", "Hay un servidor reservado para ti", anillo SVG de cuenta regresiva (stroke-dashoffset animado, mm:ss, "PARA ENTRAR", ~4 min reales), "Si no entras a tiempo, el turno pasa al siguiente de la cola." CTA "Entrar ahora" (→ stepper rápido) + "Ceder mi turno". En desktop puede ser modal sobre la home difuminada. Si expira: vuelve a home + toast ámbar. Refuerzo recomendado para pestaña en segundo plano: parpadeo de título/favicon y notificación.

### 6. Mi servidor
- Con reserva: título + chip EN JUEGO, tarjeta con imagen del mapa, nombre, "👥 N/8", tiempo activo; "▶ Conectar"; dirección copiable; acordeón "Tus poderes de admin" (mismo contenido que la chuleta, colapsado con resumen "kick · mapa · partida"); nota de público/cierre automático; "Cerrar servidor".
- Confirmación de cierre (modal/bottom-sheet): "¿Cerrar tu servidor? / Se desconectará a quien esté dentro y el sitio pasará al siguiente de la cola. Podrás reservar otro cuando quieras." → "Sí, cerrar servidor" (rojo sólido) / "No, seguir jugando". Al confirmar: libera el slot + toast "Servidor cerrado. El sitio pasa al siguiente de la cola."
- Sin reserva: vacío con icono 🎮 en caja punteada, "No tienes servidor ahora", "Reserva uno y en unos minutos estás jugando. Recuerda: 1 servidor por persona." + CTA reservar.

### 7. Perfil
- Avatar 64px, nick, "STEAM64 · <id>" en monospace + tag "SOLO LECTURA". Datos de Steam, no editables.
- Tarjeta de reserva activa (borde cian, "RESERVA ACTIVA", resumen, botón "Ir a Mi servidor") o de cola (borde violeta, posición, "Ver mi cola"); si nada: "No tienes reservas ni cola ahora mismo…"
- Botón "Cerrar sesión". Nada más.

### 8. Transversales
- **Skeletons**: replican la geometría real (header row, hero, tarjetas) con shimmer; evitar saltos de layout.
- **Vacío (0 servidores)**: icono 🛰 en caja punteada, "No hay servidores ahora mismo", "El operador aún no ha publicado ninguno. Vuelve en un rato." + "↻ Actualizar".
- **Error de sección**: caja roja "La lista no cargó / No pudimos traer los servidores. Suele resolverse al momento." + "Reintentar".
- **Backend caído (global)**: pantalla completa, logo apagado, "Estamos fuera de línea", "El servicio no responde ahora mismo. No es tu conexión: es cosa nuestra. Si tenías un servidor, tu reserva se conserva." + "↻ Reintentar" + "Reintento automático en 30 s".
- **Toasts**: fijos abajo-centro (max 420px), icono + texto, entrada vxToast, autodismiss ~3.2 s. Variantes: ok (verde), info (violeta), warn (ámbar, p. ej. rate-limit "Espera unos segundos antes de reservar de nuevo."), error (rojo).

## Interactions & Behavior
- "Reservar servidor" (hero) y "Reservar este" (tarjeta): sin sesión → login; con reserva en curso → volver al stepper; con reserva activa → toast info "Ya tienes un servidor activo…"; rate-limit 4 s → toast warn; sin libres → entrar en cola; si no, iniciar stepper (el de tarjeta apunta a ese servidor).
- Stepper: avance por etapas server-driven (el prototipo simula 2.3 s/etapa; real: ~45 s / ~3 min). Al completar estando fuera de la pantalla → toast "¡Tu servidor está listo!" y la tarjeta pasa a activa con el usuario como dueño.
- Cola FIFO: posición decrece; al llegar a #1 → pantalla/modal "¡Es tu turno!" con countdown; "Entrar ahora" → stepper rápido; expirar/ceder → siguiente en cola.
- Copiar dirección: `navigator.clipboard`, feedback doble (icono ✓ + toast); fallo → toast error con alternativa manual.
- Hover: CTA cian aclara a `#5FE2FF` y aumenta glow; outlines rellenan con `rgba(color,.06–.08)`; bordes neutros aclaran.
- El nº de servidores es dinámico (1–8+, configurable por el operador): la rejilla auto-fill no asume ninguno.

## State Management
- Sesión: `anonymous | authenticating | authenticated | authError` (Steam OpenID).
- Vista: `home | login | stepper | ready | queue | turn | myserver | profile` + flag global `backendDown`.
- Servidores: lista dinámica; cada uno `free | preparing | active | error | reservedForQueue` con `{mapa, jugadores, dueño, desde}`. Actualización en tiempo real (polling/WebSocket).
- Reserva del usuario (máx. 1): `{serverId, etapas[3|4], etapaActual, failed, done}`. Sobrevive a salir/volver (persistencia server-side; al volver, estado "reanudando").
- Cola: `{posición, esperando}`; turno: `{segundosRestantes}` (límite ~4 min).
- Toasts: pila con autodismiss.

## Assets
- Fuentes: Outfit y Source Sans 3 (Google Fonts).
- Imágenes de mapa: se cargarán desde un CDN, una por mapa (los placeholders "IMAGEN MAPA · CDN" marcan dónde). Relación aprox. 3:1 con degradado oscuro inferior para legibilidad del nombre.
- Iconos: SVG inline (rayo, reloj, mando, Steam) con stroke `#28D8FF` 1.6px; el resto son glifos de texto (⧉ ✓ ⚠ ⧗ ▶ 👥 🌙).

## Files
- `Prototipo.dc.html` — prototipo interactivo (markup + lógica de estados de referencia).
- `Board de Diseño.dc.html` — board con todas las pantallas/estados, móvil y desktop.
