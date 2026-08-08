/* Flujo de reserva. Decide qué mostrar según el estado del intent:
   en curso → stepper · LISTO → entrega · FALLIDO → error con reintento.

   El intent vive en el backend, no aquí: el usuario puede irse a la lista y volver, o
   recargar, y sigue en curso. Por eso esta pantalla solo lee y no guarda progreso local. */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clienteApi } from '@/api'
import { useFlota } from '@/context/FlotaContext'
import Cabecera from '@/components/layout/Cabecera'
import Stepper from '@/components/flujo/Stepper'
import PantallaListo from '@/components/flujo/PantallaListo'
import './Reservar.css'

export default function Reservar() {
  const { estado, refrescar } = useFlota()
  const navegar = useNavigate()
  const [reintentando, setReintentando] = useState(false)
  const [aviso, setAviso] = useState(false)

  const intent = estado?.me?.intent ?? null

  // Sin intent: o nunca reservó, o ya cerró. La lista es el sitio al que volver.
  if (!intent || intent.estado === 'CANCELADO' || intent.estado === 'EXPIRADO') {
    return (
      <>
        <Cabecera />
        <main className="rsv rsv--centro">
          <p className="rsv-vacio">No tienes ninguna reserva en curso.</p>
          <button className="rsv-volver" onClick={() => navegar('/')}>
            Volver a la lista
          </button>
        </main>
      </>
    )
  }

  if (intent.estado === 'EN_COLA') {
    navegar('/cola', { replace: true })
    return null
  }

  if (intent.estado === 'LISTO' && intent.connectUrl) {
    return (
      <>
        <Cabecera />
        <PantallaListo
          connectUrl={intent.connectUrl}
          slotIndex={intent.slotIndex}
          onIrAMiServidor={() => navegar('/mi-servidor')}
          onCerrar={async () => {
            await clienteApi.cerrar()
            await refrescar()
            navegar('/')
          }}
        />
      </>
    )
  }

  const fallido = intent.estado === 'FALLIDO'

  async function reintentar() {
    setReintentando(true)
    try {
      await clienteApi.reservar()
      await refrescar()
    } finally {
      setReintentando(false)
    }
  }

  return (
    <>
      <Cabecera />
      <main className="rsv">
        <header className="rsv-cab">
          {intent.slotIndex != null && (
            <span className="rsv-etiqueta">SERVIDOR #{intent.slotIndex} · TUYO</span>
          )}
          <h1>Preparando tu servidor</h1>
          <p>
            {intent.profile === 'ASLEEP'
              ? 'Suele tardar unos minutos. '
              : 'Menos de un minuto. '}
            Puedes salir y volver: tu reserva sigue viva.
          </p>
        </header>

        {intent.stepper && <Stepper datos={intent.stepper} fallido={fallido} />}

        {fallido ? (
          <>
            <section className="rsv-error" role="alert">
              <h2>No pudimos preparar tu servidor</h2>
              <p>
                Algo falló de nuestro lado; no es culpa tuya. Tu sitio no se pierde:
                reintenta cuando quieras.
              </p>
            </section>
            <button
              className="rsv-reintentar"
              onClick={() => void reintentar()}
              disabled={reintentando}
              aria-busy={reintentando}
            >
              {reintentando ? 'Reintentando…' : 'Reintentar'}
            </button>
            <button className="rsv-avisar" onClick={() => setAviso(true)} disabled={aviso}>
              {aviso ? 'Aviso enviado, gracias' : 'Avisar al operador'}
            </button>
          </>
        ) : (
          <button className="rsv-volver" onClick={() => navegar('/')}>
            Volver a la lista (la reserva sigue)
          </button>
        )}
      </main>
    </>
  )
}
