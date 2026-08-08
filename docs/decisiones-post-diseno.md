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
