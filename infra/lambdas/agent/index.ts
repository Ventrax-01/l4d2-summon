/* Endpoint del agente que corre en la máquina anfitriona.

   Es la ruta más frecuente del sistema: el agente consulta cada 15 segundos mientras la
   máquina está encendida. Por eso hace lo mínimo — un latido, volcar lo que ve de cada
   servidor, y llevarse las órdenes pendientes.

   El agente NO recibe órdenes por conexión entrante: es él quien pregunta. Así no hay que
   abrir ningún puerto nuevo en la casa. */

import { error, ok } from '../shared/http'
import { vieneDeCloudFront } from '../shared/origen'
import { secreto } from '../shared/ssm'
import * as m from '../shared/modelo'
import { timingSafeEqual } from 'node:crypto'

const SSM_TOKEN = process.env.ssmAgentToken!
const HOST_JUEGO = process.env.gameHost!

interface Evento {
  rawPath?: string
  body?: string
  headers?: Record<string, string | undefined>
  requestContext?: { http?: { method?: string; path?: string; sourceIp?: string } }
}

/** Comparación en tiempo constante: con `===` el tiempo de respuesta delata cuántos bytes
    coinciden, y el token se puede ir adivinando. */
async function tokenValido(cabeceras: Record<string, string | undefined>): Promise<boolean> {
  const cabecera = cabeceras.authorization ?? cabeceras.Authorization ?? ''
  const recibido = cabecera.replace(/^Bearer\s+/i, '')
  if (!recibido) return false

  const esperado = await secreto(SSM_TOKEN)
  const a = Buffer.from(recibido)
  const b = Buffer.from(esperado)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface CuerpoLatido {
  publicIp?: string
  sshActive?: boolean
  sourcebansLastUsed?: number
  slots?: m.ReporteSlot[]
  /** Órdenes ya ejecutadas, para que no se vuelvan a entregar. */
  confirmadas?: string[]
  /** Última señal antes del apagado: la máquina se va AHORA. */
  apagando?: boolean
}

/** Avanza las reservas que estén esperando a este servidor.

   El agente no decide el estado de la reserva: solo cuenta lo que ve (si el proceso corre,
   si responde, si los plugins están). El paso de una etapa a otra se decide aquí, para que
   la lógica viva en un solo sitio. */
async function avanzarReservas(reportes: m.ReporteSlot[]): Promise<void> {
  const cfg = await m.config()
  const listaSlots = await m.slots(cfg.n)

  for (const r of reportes) {
    const slot = listaSlots.find((s) => s.index === r.index)
    if (!slot?.intentId || !slot.ownerSteamId) continue
    if (slot.estado !== 'PREPARANDO') continue

    const it = await m.intentDe(slot.ownerSteamId, slot.intentId)
    if (!it || m.esTerminal(it.estado)) continue

    const ahora = Date.now()
    let siguiente = it.estado

    /* Las condiciones se encadenan sobre `siguiente`, no sobre `it.estado`, para que una
       reserva pueda subir varios escalones en la misma vuelta. Mirando el estado guardado
       solo se avanzaba uno cada 15 segundos: un servidor que ya estaba en marcha, con sus
       plugins cargados y el admin puesto, tardaba tres vueltas en darse por listo — y con
       el plazo de cada etapa corriendo, podía morir por tiempo estando ya perfecto. */
    if (siguiente === 'DESPERTANDO' || siguiente === 'BOOTEANDO') {
      if (r.corriendo) siguiente = 'INICIANDO'
    }
    if (siguiente === 'INICIANDO' && r.map) siguiente = 'VERIFICANDO'
    if (siguiente === 'VERIFICANDO' && r.pluginsOk && r.adminSembrado) siguiente = 'LISTO'

    // Aunque no cambie de etapa, hay progreso mientras el servidor responda: el plazo se
    // renueva para no matar una reserva que va bien pero lenta (un arranque en frío con la
    // caché fría puede pasarse del minuto).
    const hayProgreso = r.corriendo && (r.respondio !== false || Boolean(r.map))
    if (siguiente === it.estado && !hayProgreso) continue

    const connectUrl =
      siguiente === 'LISTO' ? await m.entregarSlot(slot.index, slot.port, HOST_JUEGO) : null

    await m.guardarIntent({
      ...it,
      estado: siguiente,
      connectUrl: connectUrl ?? it.connectUrl,
      updatedAt: ahora,
      // Cada etapa tiene su propio plazo; el barrido caduca la que se atasque de verdad.
      stateDeadline: ahora + (siguiente === 'LISTO' ? 0 : 120_000),
    })
  }
}

export async function handler(evento: Evento) {
  if (!vieneDeCloudFront(evento.headers ?? {})) {
    return error('UNAUTHORIZED', 'Acceso no autorizado.')
  }
  if (!(await tokenValido(evento.headers ?? {}))) {
    return error('UNAUTHORIZED', 'Token de agente inválido.')
  }

  const ruta = evento.requestContext?.http?.path ?? evento.rawPath ?? ''
  if (!ruta.endsWith('/agent/poll')) return error('NOT_FOUND', 'Ruta desconocida.')

  let cuerpo: CuerpoLatido = {}
  try {
    cuerpo = evento.body ? (JSON.parse(evento.body) as CuerpoLatido) : {}
  } catch {
    return error('VALIDACION', 'El cuerpo no es JSON válido.')
  }

  try {
    /* El aviso de apagado se atiende ANTES que nada y corta aquí.

       Es la última vez que se sabrá de esta máquina, así que lo que importa es dejar la
       tabla coherente de inmediato: host abajo y la orden de apagado retirada. Si en vez de
       eso se guardara un latido normal, la nube la daría por encendida hasta minuto y medio
       después, y una reserva hecha en ese hueco no mandaría el paquete de encendido. */
    if (cuerpo.apagando) {
      await Promise.all([
        m.marcarApagada(),
        ...(cuerpo.confirmadas ?? []).map((id) => m.borrarOrden(id)),
      ])
      console.info(JSON.stringify({ msg: 'la máquina avisa de que se apaga' }))
      return ok({ ok: true, ts: Date.now() })
    }

    await m.guardarLatido({
      publicIp: cuerpo.publicIp,
      sshActive: cuerpo.sshActive,
      sourcebansLastUsed: cuerpo.sourcebansLastUsed,
    })

    if (cuerpo.slots?.length) {
      await Promise.all(cuerpo.slots.map((s) => m.actualizarSlotDesdeAgente(s)))
      await avanzarReservas(cuerpo.slots)
    }

    // Lo ya ejecutado se retira antes de calcular lo pendiente.
    if (cuerpo.confirmadas?.length) {
      await Promise.all(cuerpo.confirmadas.map((id) => m.borrarOrden(id)))
    }

    const pendientes = await m.ordenesPendientes()
    const cfg = await m.config()

    return ok({
      ordenes: pendientes,
      config: { n: cfg.n, emptyCloseSec: cfg.emptyCloseSec },
      ts: Date.now(),
    })
  } catch (e) {
    console.error(JSON.stringify({ msg: 'fallo en el endpoint del agente', e: String(e) }))
    return error('UNKNOWN', 'Algo salió mal por nuestro lado.')
  }
}
