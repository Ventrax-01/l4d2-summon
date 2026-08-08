# l4d2-summon

Plataforma para **invocar servidores de Left 4 Dead 2 bajo demanda**. Los servidores corren en
una PC de casa que normalmente está **apagada**: cuando alguien reserva desde la web, el sistema
la enciende por Wake-on-LAN, levanta el servidor y se lo entrega con esa persona como admin.
Cuando nadie juega, todo se apaga solo.

Para el jugador es un botón. Detrás hay una web serverless en AWS, un agente en la PC de casa y
una flota de servidores ZoneMod provisionada con Ansible.

## Cómo funciona

```
Navegador ──► CloudFront ──► Lambda ──► DynamoDB
   │                            │
   │                            └── magic packet (Wake-on-LAN) ──┐
   │                                                              ▼
   └──────── steam://connect ─────────────────►  PC de casa (normalmente apagada)
                                                  ├── agente (polling saliente)
                                                  ├── servidores L4D2 ZoneMod
                                                  └── MySQL + SourceBans
```

El usuario **nunca ve infraestructura**: la espera se muestra como etapas de preparación de *su*
servidor. Hay dos duraciones — unos 45 segundos si el sistema está despierto, unos 3 minutos si
hay que encenderlo.

## Estructura

| Carpeta | Qué es | Estado |
|---|---|---|
| `web/` | Frontend React + Vite + TypeScript | ✅ Completo, con mocks y 88 pruebas E2E |
| `infra/` | CDK: stacks de AWS y el código de las Lambdas | ✅ Desplegado |
| `ansible/` | Provisión de la flota, y el agente que corre en la PC de casa | ✅ En producción |
| `docs/` | Especificación de producto y diseño técnico | ✅ |
| `design/` | Prototipo de interfaz | ✅ |

> El agente no tiene carpeta propia: vive en `ansible/roles/summon_agent/`, junto a lo que lo
> instala. Y el plugin de admin por servidor, que en los documentos de diseño se llamaba
> `fleet_admin`, acabó siendo `summon_admin.sp` en ese mismo rol — es de la plataforma, no de
> la flota, que funciona sin él.

Los documentos de `docs/` son el diseño **previo** a construirlo. Se conservan como quedaron
para poder ver qué se decidió y por qué, así que en algunos puntos no describen lo que acabó
existiendo; manda el código.

## Empezar

**La web, sin necesidad de nada más:**

```bash
cd web && npm install && npm run dev
```

Arranca en modo mock: funciona entera sin nube ni PC encendida. El botón *demo* abre el panel de
escenarios para recorrer todos los estados. Ver [`web/README.md`](web/README.md).

**La flota de servidores** (se ejecuta en la propia máquina que los hospeda):

```bash
cd ansible
cp group_vars/all.yml.sample group_vars/all.yml   # y rellenarlo
ansible-playbook playbook.yml --ask-become-pass
```

## Documentación

- [`docs/especificaciones-v1.md`](docs/especificaciones-v1.md) — qué hace el producto y por qué
- [`docs/diseno-tecnico.md`](docs/diseno-tecnico.md) — arquitectura, decisiones y plan por fases
- [`docs/tecnico/`](docs/tecnico/) — ocho especificaciones de detalle (datos, API, agente,
  autenticación, SourceBans, infraestructura, costos, flota)
- [`docs/decisiones-post-diseno.md`](docs/decisiones-post-diseno.md) — resoluciones posteriores

## Configuración que no vive aquí

Este repo es público, así que **la configuración real y los secretos nunca se commitean**: la
contraseña de RCON, la lista de admins y el contenido del MOTD viven solo en la máquina que
hospeda los servidores. Cada uno tiene su plantilla `.sample` en el repo; se copia y se rellena
en el despliegue.

## Licencia

MIT — ver [LICENSE](LICENSE).
