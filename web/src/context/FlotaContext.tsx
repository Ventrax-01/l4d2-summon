/* Poller único de la aplicación.
   Toda la UI lee el estado de la flota de aquí; no hay un setInterval por componente.

   La cadencia es adaptativa a propósito (docs/tecnico/02-estados-api.md §11): un intervalo
   fijo agresivo en reposo multiplicaría las invocaciones Lambda y rompería el objetivo de
   costo. Reglas:
     · lista, sin intent            → 15 s
     · intent en curso o turno      →  4 s   (temporal; vuelve a 15 s al terminar)
     · dueño de un servidor activo  → 20 s
     · pestaña oculta               → pausa total (cero requests)
     · tras error                   → backoff 10 → 60 s, se resetea al primer éxito

   Se usa setTimeout re-agendado tras cada respuesta (no setInterval) para que una respuesta
   lenta no solape peticiones. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { clienteApi } from '@/api'
import type { EstadoFlota, EstadoIntent } from '@/types'
import { ErrorApi } from '@/types'

const MS_REPOSO = 15_000
const MS_ACTIVO = 4_000
const MS_JUGANDO = 20_000
const BACKOFF_INICIAL = 10_000
const BACKOFF_MAX = 60_000

/** Estados del intent en los que el usuario está mirando el stepper. */
const INTENT_EN_CURSO: EstadoIntent[] = [
  'SOLICITADO',
  'DESPERTANDO',
  'BOOTEANDO',
  'INICIANDO',
  'VERIFICANDO',
]

function intervaloPara(estado: EstadoFlota | null): number {
  if (!estado?.me) return MS_REPOSO

  const intent = estado.me.intent
  if (intent && INTENT_EN_CURSO.includes(intent.estado)) return MS_ACTIVO
  if (estado.me.queue.promoted) return MS_ACTIVO
  if (estado.me.slot) return MS_JUGANDO

  return MS_REPOSO
}

interface ValorFlota {
  estado: EstadoFlota | null
  cargando: boolean
  /** Se llena cuando el backend no responde: dispara la pantalla de "servicio caído". */
  error: ErrorApi | null
  /** Fuerza una lectura inmediata (tras reservar, cerrar, etc.). */
  refrescar: () => Promise<void>
}

const Ctx = createContext<ValorFlota | null>(null)

export function ProveedorFlota({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<EstadoFlota | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<ErrorApi | null>(null)

  const timer = useRef<number | null>(null)
  const backoff = useRef(BACKOFF_INICIAL)
  // El intervalo se calcula sobre el último estado conocido, sin re-crear el ciclo
  // en cada render.
  const ultimo = useRef<EstadoFlota | null>(null)

  const cancelar = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const leer = useCallback(async () => {
    try {
      const nuevo = await clienteApi.obtenerEstado()
      ultimo.current = nuevo
      setEstado(nuevo)
      setError(null)
      backoff.current = BACKOFF_INICIAL
    } catch (e) {
      const err = e instanceof ErrorApi ? e : new ErrorApi('UNKNOWN', 'Error inesperado.')
      setError(err)
      backoff.current = Math.min(backoff.current * 2, BACKOFF_MAX)
    } finally {
      setCargando(false)
    }
  }, [])

  const agendar = useCallback(() => {
    cancelar()
    if (document.hidden) return // pestaña oculta: no se agenda nada

    const ms = error ? backoff.current : intervaloPara(ultimo.current)
    timer.current = window.setTimeout(async () => {
      await leer()
      agendar()
    }, ms)
  }, [cancelar, leer, error])

  const refrescar = useCallback(async () => {
    await leer()
    agendar()
  }, [leer, agendar])

  useEffect(() => {
    void refrescar()

    const alCambiarVisibilidad = () => {
      if (document.hidden) {
        cancelar() // cero requests en segundo plano
      } else {
        void refrescar() // al volver: lectura inmediata y se re-arma el ciclo
      }
    }

    document.addEventListener('visibilitychange', alCambiarVisibilidad)
    return () => {
      document.removeEventListener('visibilitychange', alCambiarVisibilidad)
      cancelar()
    }
    // Solo al montar: el ciclo se re-agenda solo tras cada respuesta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Ctx.Provider value={{ estado, cargando, error, refrescar }}>{children}</Ctx.Provider>
  )
}

export function useFlota(): ValorFlota {
  const v = useContext(Ctx)
  if (!v) throw new Error('useFlota debe usarse dentro de <ProveedorFlota>')
  return v
}
