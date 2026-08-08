/* Motor de simulación del modo mock.

   Mantiene un estado en memoria y lo hace avanzar con el reloj, igual que haría el
   backend real: el intent recorre las etapas por tiempo, los servidores se llenan, y la
   cola promueve al primero cuando se libera un slot. Así el front se desarrolla contra
   un sistema que se comporta, no contra respuestas fijas.

   Los tiempos son los del diseño (docs/tecnico/02-estados-api.md §3):
     · ASLEEP (~3 min) → Despertando · Iniciando · Verificando · ¡Listo!
     · AWAKE  (~45 s)  → Iniciando · Verificando · ¡Listo!
   El multiplicador de velocidad del escenario los divide para poder iterar sin esperar. */

import type {
  EstadoFlota,
  EstadoHost,
  EstadoIntent,
  EstadoSlot,
  Intent,
  Slot,
  Stepper,
} from '@/types'
import { obtenerEscenario, suscribirEscenario, type Escenario } from './escenarios'
import {
  CAMPANIAS,
  MI_STEAM_ID,
  NICKS,
  connectDe,
  estable,
} from './datos'

/** Duración de cada estado interno, en segundos reales. */
const DURACION: Record<string, { ASLEEP: number; AWAKE: number }> = {
  DESPERTANDO: { ASLEEP: 90, AWAKE: 0 },
  BOOTEANDO: { ASLEEP: 30, AWAKE: 15 },
  INICIANDO: { ASLEEP: 40, AWAKE: 20 },
  VERIFICANDO: { ASLEEP: 20, AWAKE: 10 },
}

/** Segundos que el mock tarda en liberar un slot y promover al primero de la cola. */
const SEGUNDOS_HASTA_PROMOVER = 25
/** Ventana para reclamar el turno (el backend real usa Config.claimWindowSec). */
const SEGUNDOS_PARA_RECLAMAR = 180

interface SlotInterno extends Slot {
  ownerSteamId?: string
}

interface EstadoInterno {
  host: EstadoHost
  hostDesde: number
  slots: SlotInterno[]
  intent: Intent | null
  /** Momento en que el intent entró a su estado actual. */
  intentDesde: number
  colaLongitud: number
  enCola: boolean
  colaPosicion: number | null
  colaDesde: number
  promovido: boolean
  claimDeadline: number | null
  sesion: boolean
}

let st: EstadoInterno = crear(obtenerEscenario())

/** Rehacer el mundo cuando cambia el escenario (el panel lo dispara). */
suscribirEscenario((e) => {
  st = crear(e)
})

function crear(e: Escenario): EstadoInterno {
  const ahora = Date.now()
  const slots: SlotInterno[] = Array.from({ length: e.numServidores }, (_, i) => {
    const index = i + 1
    if (!e.todosOcupados) return { index, estado: 'LIBRE' as EstadoSlot }

    const camp = estable(CAMPANIAS, index)
    return {
      index,
      estado: 'ACTIVO' as EstadoSlot,
      ownerNick: estable(NICKS, index + 1),
      ownerSteamId: `7656119800000000${index}`,
      map: camp.map,
      players: 2 + (index % 6),
      maxPlayers: 8,
      since: ahora - (index * 17 + 5) * 60_000,
      connect: connectDe(index),
    }
  })

  return {
    host: e.todosOcupados ? 'UP' : e.hostInicial,
    hostDesde: ahora,
    slots,
    intent: null,
    intentDesde: ahora,
    colaLongitud: e.todosOcupados ? 2 : 0,
    enCola: false,
    colaPosicion: null,
    colaDesde: ahora,
    promovido: false,
    claimDeadline: null,
    sesion: e.sesionIniciada,
  }
}

function escala(segundos: number): number {
  return (segundos * 1000) / obtenerEscenario().velocidad
}

/** Cadena de estados según el perfil. */
function cadena(perfil: 'ASLEEP' | 'AWAKE'): EstadoIntent[] {
  return perfil === 'ASLEEP'
    ? ['DESPERTANDO', 'BOOTEANDO', 'INICIANDO', 'VERIFICANDO', 'LISTO']
    : ['BOOTEANDO', 'INICIANDO', 'VERIFICANDO', 'LISTO']
}

/** Mapea el estado interno a la celda visible del stepper (§3.2 de la spec). */
export function stepperDe(estado: EstadoIntent, perfil: 'ASLEEP' | 'AWAKE'): Stepper {
  const labels =
    perfil === 'ASLEEP'
      ? ['Despertando', 'Iniciando', 'Verificando', '¡Listo!']
      : ['Iniciando', 'Verificando', '¡Listo!']

  const celda: Record<string, number> = perfil === 'ASLEEP'
    ? { DESPERTANDO: 1, BOOTEANDO: 2, INICIANDO: 2, VERIFICANDO: 3, LISTO: 4 }
    : { BOOTEANDO: 1, INICIANDO: 1, VERIFICANDO: 2, LISTO: 3 }

  return { total: labels.length, current: celda[estado] ?? 1, labels }
}

/** Avanza el mundo hasta "ahora". Se llama en cada lectura. */
function avanzar(): void {
  const e = obtenerEscenario()
  const ahora = Date.now()

  // --- Progreso del intent ---
  const it = st.intent
  if (it && it.profile && !esTerminal(it.estado) && it.estado !== 'EN_COLA') {
    const perfil = it.profile
    const secuencia = cadena(perfil)
    const idx = secuencia.indexOf(it.estado)

    if (idx >= 0 && it.estado !== 'LISTO') {
      const dur = DURACION[it.estado]?.[perfil] ?? 10
      if (ahora - st.intentDesde >= escala(dur)) {
        // El escenario de fallo corta justo antes de entregar.
        if (e.fallaPreparacion && it.estado === 'VERIFICANDO') {
          st.intent = {
            ...it,
            estado: 'FALLIDO',
            errorCode: 'VERIFY_TIMEOUT',
            errorMsg: 'El servidor arrancó pero no terminó de responder.',
          }
          liberarSlotDe(it.slotIndex)
        } else {
          const siguiente = secuencia[idx + 1]
          st.intent = { ...it, estado: siguiente, stepper: stepperDe(siguiente, perfil) }
          st.intentDesde = ahora
          if (siguiente === 'BOOTEANDO') st.host = 'UP'
          if (siguiente === 'LISTO') entregar(it.slotIndex)
        }
      }
    }
  }

  // --- Cola: se libera un slot y me promueven ---
  if (st.enCola && !st.promovido && ahora - st.colaDesde >= escala(SEGUNDOS_HASTA_PROMOVER)) {
    const victima = st.slots.find((s) => s.estado === 'ACTIVO')
    if (victima) {
      victima.estado = 'RESERVADO_COLA'
      victima.ownerNick = undefined
      victima.ownerSteamId = undefined
      victima.connect = undefined
      victima.players = undefined
      st.promovido = true
      st.colaPosicion = 1
      st.claimDeadline = ahora + escala(SEGUNDOS_PARA_RECLAMAR)
      if (st.intent) st.intent = { ...st.intent, queue: { position: 1, promoted: true } }
    }
  }

  // --- El turno expira si no lo reclamo ---
  if (st.promovido && st.claimDeadline && ahora > st.claimDeadline) {
    const reservado = st.slots.find((s) => s.estado === 'RESERVADO_COLA')
    if (reservado) reservado.estado = 'LIBRE'
    st.enCola = false
    st.promovido = false
    st.colaPosicion = null
    st.claimDeadline = null
    if (st.intent?.estado === 'EN_COLA') st.intent = { ...st.intent, estado: 'EXPIRADO' }
  }
}

function esTerminal(e: EstadoIntent): boolean {
  return e === 'LISTO' || e === 'FALLIDO' || e === 'CANCELADO' || e === 'EXPIRADO'
}

function entregar(slotIndex: number | null): void {
  if (slotIndex == null) return
  const s = st.slots.find((x) => x.index === slotIndex)
  if (!s) return
  const camp = estable(CAMPANIAS, slotIndex)
  s.estado = 'ACTIVO'
  s.ownerNick = 'R4zor'
  s.ownerSteamId = MI_STEAM_ID
  s.map = camp.map
  s.players = 1
  s.maxPlayers = 8
  s.since = Date.now()
  s.connect = connectDe(slotIndex)
  if (st.intent) st.intent = { ...st.intent, connectUrl: connectDe(slotIndex) }
}

function liberarSlotDe(slotIndex: number | null): void {
  if (slotIndex == null) return
  const s = st.slots.find((x) => x.index === slotIndex)
  if (!s) return
  s.estado = 'LIBRE'
  s.ownerNick = undefined
  s.ownerSteamId = undefined
  s.connect = undefined
  s.players = undefined
  s.map = undefined
  s.since = undefined
}

// ---------------------------------------------------------------- API del motor

export function leerEstado(): EstadoFlota {
  avanzar()
  const e = obtenerEscenario()

  const slots: Slot[] = st.slots.map(({ ownerSteamId: _omitido, ...s }) => s)

  const base: EstadoFlota = {
    host: { state: st.host, since: st.hostDesde },
    config: { n: e.numServidores, reservasEnabled: true },
    slots,
    queue: { length: st.colaLongitud + (st.enCola ? 1 : 0) },
    ts: Date.now(),
  }

  if (!st.sesion) return base

  const mio = st.slots.find((s) => s.ownerSteamId === MI_STEAM_ID)

  return {
    ...base,
    me: {
      steamId: MI_STEAM_ID,
      operador: false,
      suspendido: false,
      // Se devuelve también el intent terminal (LISTO/FALLIDO): la UI necesita el
      // último resultado para pintar la pantalla de entrega o la de error. El backend
      // real lo limpia al confirmar, así que el front no debe asumir que persiste.
      intent: st.intent,
      queue: {
        inQueue: st.enCola,
        position: st.colaPosicion,
        promoted: st.promovido,
        claimDeadline: st.claimDeadline,
      },
      slot: mio
        ? {
            index: mio.index,
            connect: mio.connect!,
            players: mio.players,
            map: mio.map,
            emptySince: null,
          }
        : null,
    },
  }
}

export function reservar(): Intent {
  avanzar()

  // Idempotencia: si ya tengo un intent vivo, devuelvo ese mismo.
  if (st.intent && !esTerminal(st.intent.estado)) {
    // Salvo que sea reclamar un turno promovido.
    if (!(st.intent.estado === 'EN_COLA' && st.promovido)) return st.intent
  }

  const ahora = Date.now()
  const libre =
    st.slots.find((s) => s.estado === 'RESERVADO_COLA' && st.promovido) ??
    st.slots.find((s) => s.estado === 'LIBRE')

  if (!libre) {
    // Todo ocupado: a la cola.
    st.enCola = true
    st.colaDesde = ahora
    st.colaPosicion = st.colaLongitud + 1
    st.intent = {
      id: `int_${ahora}`,
      estado: 'EN_COLA',
      profile: null,
      slotIndex: null,
      connectUrl: null,
      errorCode: null,
      createdAt: ahora,
      queue: { position: st.colaPosicion, promoted: false },
    }
    st.intentDesde = ahora
    return st.intent
  }

  // Reclamo del turno: dejo de estar en cola.
  if (st.promovido) {
    st.enCola = false
    st.promovido = false
    st.colaPosicion = null
    st.claimDeadline = null
    st.colaLongitud = Math.max(0, st.colaLongitud - 1)
  }

  const perfil: 'ASLEEP' | 'AWAKE' = st.host === 'UP' ? 'AWAKE' : 'ASLEEP'
  const primero = cadena(perfil)[0]
  libre.estado = 'PREPARANDO'

  st.intent = {
    id: `int_${ahora}`,
    estado: primero,
    profile: perfil,
    slotIndex: libre.index,
    stepper: stepperDe(primero, perfil),
    connectUrl: null,
    errorCode: null,
    createdAt: ahora,
  }
  st.intentDesde = ahora
  if (perfil === 'ASLEEP') st.host = 'WAKING'

  return st.intent
}

export function cerrar(): { ok: true; closed?: { slotIndex: number } } {
  avanzar()

  const mio = st.slots.find((s) => s.ownerSteamId === MI_STEAM_ID)
  if (mio) {
    const index = mio.index
    liberarSlotDe(index)
    st.intent = null
    return { ok: true, closed: { slotIndex: index } }
  }

  if (st.intent && !esTerminal(st.intent.estado)) {
    liberarSlotDe(st.intent.slotIndex)
    st.intent = { ...st.intent, estado: 'CANCELADO' }
    st.enCola = false
    st.promovido = false
    st.colaPosicion = null
    return { ok: true }
  }

  return { ok: true }
}

export function salirDeCola(): void {
  const reservado = st.slots.find((s) => s.estado === 'RESERVADO_COLA')
  if (reservado) reservado.estado = 'LIBRE'
  st.enCola = false
  st.promovido = false
  st.colaPosicion = null
  st.claimDeadline = null
  if (st.intent?.estado === 'EN_COLA') st.intent = null
}

export function entrarACola(): { inQueue: boolean; position: number } {
  if (!st.enCola) {
    st.enCola = true
    st.colaDesde = Date.now()
    st.colaPosicion = st.colaLongitud + 1
  }
  return { inQueue: true, position: st.colaPosicion ?? 1 }
}

export function intentActual(): Intent | null {
  avanzar()
  return st.intent
}

export function iniciarSesion(): void {
  st.sesion = true
}

export function cerrarSesion(): void {
  st.sesion = false
}

export function haySesion(): boolean {
  return st.sesion
}
