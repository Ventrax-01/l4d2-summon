/* Cola de espera. Dos momentos muy distintos:

   · Esperando  → posición y calma: "tu sitio se guarda".
   · Tu turno   → urgente y con cuenta regresiva: si no entra a tiempo, pasa al siguiente.

   La cuenta atrás se calcula contra el `claimDeadline` del backend, no con un contador
   local: así sigue siendo correcta aunque el usuario recargue o deje la pestaña de fondo. */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clienteApi } from '@/api'
import { useFlota } from '@/context/FlotaContext'
import Cabecera from '@/components/layout/Cabecera'
import './Cola.css'

const CIRCUNFERENCIA = 364 // 2πr con r=58, como en el diseño

export default function Cola() {
  const { estado, refrescar } = useFlota()
  const navegar = useNavigate()
  const [entrando, setEntrando] = useState(false)
  const [ahora, setAhora] = useState(Date.now())

  const cola = estado?.me?.queue
  const deadline = cola?.claimDeadline ?? null

  // Tic local solo para repintar la cuenta atrás; la verdad la tiene el backend.
  useEffect(() => {
    if (!deadline) return
    const id = window.setInterval(() => setAhora(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [deadline])

  if (!cola?.inQueue) {
    return (
      <>
        <Cabecera />
        <main className="cola cola--vacia">
          <p>No estás en la cola.</p>
          <button className="cola-sec" onClick={() => navegar('/')}>
            Volver a la lista
          </button>
        </main>
      </>
    )
  }

  async function salir() {
    await clienteApi.salirDeCola()
    await refrescar()
    navegar('/')
  }

  async function entrarAhora() {
    setEntrando(true)
    try {
      await clienteApi.reservar()
      await refrescar()
      navegar('/reservar')
    } finally {
      setEntrando(false)
    }
  }

  // --- Es tu turno ---
  if (cola.promoted && deadline) {
    const restante = Math.max(0, Math.floor((deadline - ahora) / 1000))
    const total = 180
    const proporcion = Math.min(1, restante / total)
    const mm = String(Math.floor(restante / 60)).padStart(2, '0')
    const ss = String(restante % 60).padStart(2, '0')

    return (
      <>
        <Cabecera />
        <main className="cola cola--turno">
          <span className="cola-badge-turno">¡ES TU TURNO!</span>
          <h1>
            Hay un servidor
            <br />
            reservado para ti
          </h1>

          <div className="cola-anillo">
            <svg width="132" height="132" viewBox="0 0 132 132" aria-hidden="true">
              <circle cx="66" cy="66" r="58" fill="none" stroke="var(--border-faint)" strokeWidth="8" />
              <circle
                cx="66"
                cy="66"
                r="58"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={CIRCUNFERENCIA}
                strokeDashoffset={CIRCUNFERENCIA * (1 - proporcion)}
              />
            </svg>
            <div className="cola-reloj">
              <span className="cola-reloj-num">
                {mm}:{ss}
              </span>
              <span className="cola-reloj-rot">PARA ENTRAR</span>
            </div>
          </div>

          <p className="cola-texto" role="status">
            Si no entras a tiempo, el turno pasa al siguiente de la cola.
          </p>

          <button
            className="cola-cta"
            onClick={() => void entrarAhora()}
            disabled={entrando}
            aria-busy={entrando}
          >
            {entrando ? 'Entrando…' : 'Entrar ahora'}
          </button>
          <button className="cola-sec" onClick={() => void salir()}>
            Ceder mi turno
          </button>
        </main>
      </>
    )
  }

  // --- Esperando ---
  const esperando = Math.max(0, (estado?.queue.length ?? 1) - 1)

  return (
    <>
      <Cabecera />
      <main className="cola">
        <span className="cola-badge">⧗ EN COLA</span>

        <div className="cola-pos">
          <span className="cola-pos-num">#{cola.position ?? 1}</span>
          <span className="cola-pos-rot">tu posición en la cola</span>
        </div>

        <p className="cola-texto">
          Ahora mismo todos los servidores están ocupados.{' '}
          {esperando > 0 &&
            `${esperando} ${esperando === 1 ? 'persona espera' : 'personas esperan'} también. `}
          En cuanto se libere uno y te toque, te avisamos aquí mismo.
        </p>

        <p className="cola-pista">
          <span className="cola-punto" aria-hidden="true" />
          Puedes dejar esta pestaña de fondo, tu sitio se guarda.
        </p>

        <button className="cola-salir" onClick={() => void salir()}>
          Salir de la cola
        </button>
      </main>
    </>
  )
}
