/* Avisos efímeros.

   Se usan para confirmar acciones ("dirección copiada"), avisar de límites ("espera unos
   segundos") y dar la buena noticia cuando el usuario no está mirando el stepper ("¡tu
   servidor está listo!"). Se apilan abajo al centro y se van solos. */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import './Toasts.css'

export type TipoToast = 'ok' | 'info' | 'warn' | 'error'

interface Toast {
  id: number
  texto: string
  tipo: TipoToast
}

const ICONO: Record<TipoToast, string> = {
  ok: '✓',
  info: 'ℹ',
  warn: '⏱',
  error: '⚠',
}

const DURACION = 3200

interface ValorToasts {
  mostrar: (texto: string, tipo?: TipoToast) => void
}

const Ctx = createContext<ValorToasts | null>(null)

export function ProveedorToasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const siguienteId = useRef(1)

  const mostrar = useCallback((texto: string, tipo: TipoToast = 'info') => {
    const id = siguienteId.current++
    setToasts((t) => [...t, { id, texto, tipo }])
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
    }, DURACION)
  }, [])

  const valor = useMemo(() => ({ mostrar }), [mostrar])

  return (
    <Ctx.Provider value={valor}>
      {children}
      {/* aria-live para que un lector de pantalla anuncie el aviso sin robar el foco. */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tipo}`}>
            <span className="toast-ico" aria-hidden="true">
              {ICONO[t.tipo]}
            </span>
            <span>{t.texto}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToasts(): ValorToasts {
  const v = useContext(Ctx)
  if (!v) throw new Error('useToasts debe usarse dentro de <ProveedorToasts>')
  return v
}
