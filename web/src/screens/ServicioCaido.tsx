/* Pantalla global de servicio caído: no carga NADA, así que no tiene sentido enrutar.
   Es distinta del error de la lista, que sí deja usar el resto de la aplicación.

   Reintenta sola cada 30 s: si el servicio vuelve mientras el usuario mira la pantalla,
   se recupera sin que tenga que hacer nada. */

import { useEffect, useState } from 'react'
import { useFlota } from '@/context/FlotaContext'
import './ServicioCaido.css'

const SEGUNDOS_REINTENTO = 30

export default function ServicioCaido() {
  const { refrescar } = useFlota()
  const [restante, setRestante] = useState(SEGUNDOS_REINTENTO)

  useEffect(() => {
    const id = window.setInterval(() => {
      setRestante((s) => {
        if (s <= 1) {
          void refrescar()
          return SEGUNDOS_REINTENTO
        }
        return s - 1
      })
    }, 1000)
    return () => window.clearInterval(id)
  }, [refrescar])

  return (
    <>
      <main className="caido">
        <span className="caido-logo" aria-hidden="true">
          V
        </span>
        <h1>Estamos fuera de línea</h1>
        <p>
          El servicio no responde ahora mismo. No es tu conexión: es cosa nuestra. Si tenías un
          servidor, tu reserva se conserva.
        </p>
        <button
          className="caido-btn"
          onClick={() => {
            setRestante(SEGUNDOS_REINTENTO)
            void refrescar()
          }}
        >
          <span aria-hidden="true">↻</span> Reintentar
        </button>
        <p className="caido-auto" role="status">
          Reintento automático en {restante} s
        </p>
      </main>
    </>
  )
}
