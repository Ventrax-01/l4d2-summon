# Resolución de las preguntas bloqueantes del diseño técnico

Fecha: 2026-07-22. Respuestas del usuario a las 2 BLOQUEANTES de `diseno-tecnico.md` §9.
Estas resoluciones mandan sobre lo que digan los specs de dominio.

## B1 — Co-tenencia de la PC (InfoGestion + Grafana 24/7)

**Resolución: el auto-apagado queda TAL CUAL se diseñó. La PC se apaga cuando queda ociosa, y que
InfoGestion y Grafana caigan con ella es ACEPTABLE.**

- **InfoGestion no importa**: se acepta que `infogestion.ventrax.dev:444` esté caído cuando la PC
  está apagada. No es un servicio que deba estar 24/7.
- **Grafana** (`:5432`) son los gráficos estadísticos de los servidores de juego, que **solo tienen
  sentido cuando la PC está prendida** (que es justo cuando hay servidores corriendo). Que se apague
  con la PC no solo es aceptable: está alineado — no hay nada que monitorear con la PC apagada.
- **Consecuencia:** NO hace falta una máquina dedicada para L4D2 ni cambiar el modelo de energía. El
  conflicto que marcó la revisión adversarial queda descartado por decisión del usuario.

## B2 — IP pública de casa

**Resolución: la IP pública es FIJA (estática).**

Simplificaciones que esto habilita (aplicar en el diseño):
- **WoL:** la Lambda apunta el magic packet a la **IP fija** conocida. Se elimina el riesgo de "IP
  obsoleta cuando la PC está apagada" (era el riesgo top #1) — ya no aplica.
- **Ruteo de `/sourcebans`:** el origen de CloudFront apunta a un registro DNS estable hacia la IP
  fija. **Se elimina toda la maquinaria de DNS dinámico (DDNS):** no hace falta que el agente/router
  actualice un registro `home.ventrax.dev` en cada heartbeat.
- **Agente:** se elimina la detección/reporte de cambio de IP pública (ya no es necesaria).
- El certificado del lado de casa (Let's Encrypt) se emite para el hostname estable, sin cambios por
  IP variable.

## Efecto neto sobre los riesgos del diseño

- Riesgo #1 (fiabilidad del WoL con IP obsoleta) → **degradado**: la IP es fija y el WoL ya está
  verificado funcionando desde internet. Queda solo la disciplina de timing (esperar a S5 antes de
  enviar).
- Riesgo #2 (capacidad real de la PC para fijar N) → **sigue vigente**: hay que medir cuántas
  instancias L4D2 aguanta antes de fijar N (ahora sin la agravante de co-tenencia crítica, ya que
  InfoGestion es prescindible).
- Riesgo #3 (abuso de encendido) → sin cambios; mitigado por el rate-limit atómico en el claim.

---

## Decisiones de repositorio (2026-08-08)

**Monorepo público `l4d2-summon`.** Todo el sistema vive en un solo repositorio, público:
`web/`, `infra/`, `agent/`, `ansible/`, `docs/`, `design/`.

| Decisión | Detalle |
|---|---|
| **Nombre** | `l4d2-summon` — "invocar" un servidor describe la experiencia del jugador mejor que cualquier término de infraestructura. Sustituye al provisional `l4d2-panel`. |
| **Visibilidad** | **Público.** Esto anula el argumento que sostenía la separación de repos: ya no hay conflicto entre un repo público (la flota) y uno privado (el panel). |
| **Fusión de `l4d2-fleet`** | Su contenido pasa a `ansible/` como material nuevo. El repositorio original queda **archivado** en GitHub con un aviso; su historia sigue consultable ahí. |
| **Ubicación del agente** | `agent/` en este monorepo, **no** en el Ansible. El agente es un cliente de la API del panel (habla `/agent/poll`), así que pertenece junto al contrato que consume. Ansible solo lo instala, copiándolo del checkout local. |
| **Plugin `fleet_admin.sp`** | Se queda en `ansible/roles/l4d2_fleet/files/custom-plugins/`, junto a los demás plugins del juego. |
| **Pipelines** | Uno por pieza, filtrado por ruta (`paths:`). Si aparece un contrato compartido, su ruta debe incluirse en los filtros de front y back, o se despliegan desincronizados. |

### Correcciones a los documentos de diseño

- `04-agente.md` afirma que **`l4d2-fleet` es privado**: era **falso**, siempre fue público. La
  justificación de "copiar desde el checkout local por privacidad" no aplica; se copia igual, pero
  por simplicidad. **Ningún secreto se commitea**, que es lo que de verdad importa.
- Donde los documentos digan `l4d2-panel` o `ventrax-servers`, léase **`l4d2-summon`**.
- Donde ubiquen el agente bajo el repo de Ansible, léase **`agent/` en el monorepo**.

### Rutas de runtime en la máquina anfitriona

`/opt/l4d2-fleet` y `/etc/l4d2-fleet` **se mantienen sin renombrar**. Están referenciadas por las
units de systemd en ejecución, el launcher, el exporter y Promtail; renombrarlas obligaría a
reiniciar los cuatro servidores (desconectando jugadores) sin ninguna ganancia funcional. Son
rutas internas. El checkout sí se movió a `/home/ventrax/l4d2-summon`.

**Configuración que solo vive en la máquina** (nunca en el repo) y que se preservó en la
migración: `ansible/group_vars/all.yml`, `motd.local.html` y `host.local.html`.
