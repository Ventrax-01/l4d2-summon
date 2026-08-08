/* Escenarios conmutables del modo mock.

   Son los mismos que el prototipo del diseño expone en su panel de "Tweaks": permiten
   recorrer todos los estados de la UI sin backend ni PC encendida. El escenario vive en
   localStorage para que recargar no lo pierda, y se puede fijar por query param. */

export interface Escenario {
  /** Tope de servidores. El diseño exige que la rejilla aguante de 1 a 8. */
  numServidores: number
  /** Estado inicial de la máquina: DOWN fuerza el flujo largo (~3 min). */
  hostInicial: 'DOWN' | 'UP'
  /** Arranca con todos los slots ocupados: el siguiente que reserve va a la cola. */
  todosOcupados: boolean
  /** El intent falla al preparar el servidor (para ver el error del stepper). */
  fallaPreparacion: boolean
  /** El login con Steam devuelve error. */
  loginFalla: boolean
  /** GET /api/state falla: error de sección en la lista. */
  errorDeLista: boolean
  /** Todo el backend está caído: pantalla global de servicio caído. */
  backendCaido: boolean
  /** Si arranco con sesión iniciada (para probar la home pública, ponlo en false). */
  sesionIniciada: boolean
  /** Multiplicador de velocidad: x1 respeta los tiempos reales; x20 sirve para iterar. */
  velocidad: 1 | 5 | 20
}

export const ESCENARIO_POR_DEFECTO: Escenario = {
  numServidores: 4,
  hostInicial: 'DOWN',
  todosOcupados: false,
  fallaPreparacion: false,
  loginFalla: false,
  errorDeLista: false,
  backendCaido: false,
  sesionIniciada: true,
  velocidad: 5,
}

const CLAVE = 'l4d2panel.escenario'

function desdeQuery(): Partial<Escenario> {
  if (typeof window === 'undefined') return {}
  const q = new URLSearchParams(window.location.search)
  const p: Partial<Escenario> = {}
  const n = q.get('n')
  if (n) p.numServidores = Math.min(8, Math.max(1, Number(n) || 4))
  if (q.get('host')) p.hostInicial = q.get('host') === 'up' ? 'UP' : 'DOWN'
  if (q.get('ocupados') === '1') p.todosOcupados = true
  if (q.get('falla') === '1') p.fallaPreparacion = true
  if (q.get('caido') === '1') p.backendCaido = true
  if (q.get('anon') === '1') p.sesionIniciada = false
  const v = q.get('vel')
  if (v === '1' || v === '5' || v === '20') p.velocidad = Number(v) as Escenario['velocidad']
  return p
}

function leerGuardado(): Partial<Escenario> {
  try {
    const raw = localStorage.getItem(CLAVE)
    return raw ? (JSON.parse(raw) as Partial<Escenario>) : {}
  } catch {
    return {}
  }
}

let actual: Escenario = { ...ESCENARIO_POR_DEFECTO, ...leerGuardado(), ...desdeQuery() }

const suscriptores = new Set<(e: Escenario) => void>()

export function obtenerEscenario(): Escenario {
  return actual
}

export function fijarEscenario(cambios: Partial<Escenario>): void {
  actual = { ...actual, ...cambios }
  try {
    localStorage.setItem(CLAVE, JSON.stringify(actual))
  } catch {
    /* modo privado o storage lleno: el escenario sigue vivo en memoria */
  }
  suscriptores.forEach((f) => f(actual))
}

export function reiniciarEscenario(): void {
  try {
    localStorage.removeItem(CLAVE)
  } catch {
    /* sin storage no hay nada que limpiar */
  }
  actual = { ...ESCENARIO_POR_DEFECTO }
  suscriptores.forEach((f) => f(actual))
}

export function suscribirEscenario(f: (e: Escenario) => void): () => void {
  suscriptores.add(f)
  return () => suscriptores.delete(f)
}
