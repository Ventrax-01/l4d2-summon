/* Tipos del contrato con el backend.
   Derivados de docs/tecnico/02-estados-api.md §8 (API pública). Cambiar algo aquí
   implica cambiar la spec: son el mismo contrato. Timestamps = epoch en milisegundos. */

/** Estado de la máquina que hospeda los servidores. El usuario nunca ve esto directamente. */
export type EstadoHost = 'DOWN' | 'WAKING' | 'UP'

/** Estado de un slot de servidor. */
export type EstadoSlot =
  | 'LIBRE'           // sin dueño, disponible
  | 'PREPARANDO'      // asignado a un intent que está arrancando
  | 'ACTIVO'          // entregado, con dueño y gente jugando
  | 'VACIO'           // activo pero sin humanos; corre el timer de cierre
  | 'RESERVADO_COLA'  // liberado y guardado para el primero de la cola
  | 'CERRANDO'        // el agente lo está deteniendo
  | 'ERROR'           // no se pudo preparar; el operador tiene que mirarlo

/** Estados del intent de reserva. Los intermedios se mapean al stepper que ve el usuario. */
export type EstadoIntent =
  | 'SOLICITADO'
  | 'EN_COLA'
  | 'DESPERTANDO'
  | 'BOOTEANDO'
  | 'INICIANDO'
  | 'VERIFICANDO'
  | 'LISTO'
  | 'FALLIDO'
  | 'CANCELADO'
  | 'EXPIRADO'

/** Perfil de duración: ASLEEP añade la etapa "Despertando" (~3min); AWAKE no (~45s).
    No existe un tercer perfil "instantáneo". */
export type PerfilDuracion = 'AWAKE' | 'ASLEEP'

/** El backend pre-computa el stepper para que el front no conozca los estados internos. */
export interface Stepper {
  total: number
  current: number
  labels: string[]
}

export interface Slot {
  index: number
  estado: EstadoSlot
  ownerNick?: string
  map?: string
  players?: number
  maxPlayers?: number
  since?: number
  /** Presente solo si ACTIVO o VACIO. */
  connect?: string
}

export interface Intent {
  id: string
  estado: EstadoIntent
  profile: PerfilDuracion | null
  slotIndex: number | null
  stepper?: Stepper
  connectUrl: string | null
  errorCode: string | null
  errorMsg?: string | null
  createdAt?: number
  /** Presente cuando el intent está EN_COLA. */
  queue?: { position: number; promoted: boolean }
}

export interface EstadoCola {
  inQueue: boolean
  position: number | null
  promoted: boolean
  claimDeadline: number | null
}

/** Slot del que soy dueño ahora mismo. */
export interface MiSlot {
  index: number
  connect: string
  players?: number
  map?: string
  emptySince?: number | null
}

/** Bloque `me` de /api/state: presente solo con sesión válida. */
export interface Yo {
  steamId: string
  operador: boolean
  suspendido: boolean
  intent: Intent | null
  queue: EstadoCola
  slot: MiSlot | null
}

/** Respuesta de GET /api/state — el endpoint que alimenta casi toda la UI. */
export interface EstadoFlota {
  host: { state: EstadoHost; since?: number }
  config: { n: number; reservasEnabled: boolean }
  slots: Slot[]
  queue: { length: number }
  me?: Yo
  ts: number
}

/** Perfil del usuario (GET /api/me). El nick y el avatar vienen de Steam: solo lectura. */
export interface Perfil {
  steamId: string
  nick: string
  avatar: string
  operador: boolean
  suspendido: boolean
  intent: Intent | null
  queue: { inQueue: boolean; position: number | null }
  slot: { index: number; connect: string } | null
  limits: {
    wakesToday: number
    maxWakesPerDay: number
    cooldownRemainingSec: number
  }
}

/** Códigos de error del backend que la UI traduce a mensajes propios. */
export type CodigoError =
  | 'SUSPENDED'
  | 'RESERVAS_DISABLED'
  | 'COOLDOWN'
  | 'WAKE_LIMIT'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'BACKEND_DOWN'
  | 'UNKNOWN'

export class ErrorApi extends Error {
  constructor(
    public codigo: CodigoError,
    mensaje: string,
    public status?: number,
  ) {
    super(mensaje)
    this.name = 'ErrorApi'
  }
}
