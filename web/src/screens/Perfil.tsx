/* Perfil. Todo viene de Steam y es de solo lectura: aquí no hay nada que configurar,
   y decirlo evita que el usuario busque ajustes que no existen. */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clienteApi } from '@/api'
import { useFlota } from '@/context/FlotaContext'
import Cabecera from '@/components/layout/Cabecera'
import { iniciales, nombreDeMapa } from '@/lib/formato'
import type { Perfil as DatosPerfil } from '@/types'
import './Perfil.css'

export default function Perfil() {
  const { estado, refrescar } = useFlota()
  const navegar = useNavigate()
  const [perfil, setPerfil] = useState<DatosPerfil | null>(null)

  useEffect(() => {
    clienteApi
      .obtenerPerfil()
      .then(setPerfil)
      .catch(() => setPerfil(null))
  }, [])

  const me = estado?.me
  const slot = estado?.slots.find((s) => s.index === me?.slot?.index)
  const enCola = me?.queue.inQueue ?? false

  async function salir() {
    await clienteApi.salir()
    await refrescar()
    navegar('/', { replace: true })
  }

  return (
    <>
      <Cabecera />
      <main className="prf">
        <header className="prf-cab">
          <span className="prf-avatar" aria-hidden="true">
            {iniciales(perfil?.nick ?? 'R4zor')}
          </span>
          <div className="prf-ident">
            <h1>{perfil?.nick ?? 'R4zor'}</h1>
            <p className="prf-steam">
              <code>STEAM64 · {perfil?.steamId ?? me?.steamId ?? '—'}</code>
              <span className="prf-ro">SOLO LECTURA</span>
            </p>
          </div>
        </header>

        {me?.slot && slot && (
          <section className="prf-card prf-card--activa">
            <div>
              <span className="prf-rotulo prf-rotulo--activo">
                <span className="prf-punto" aria-hidden="true" />
                RESERVA ACTIVA
              </span>
              <p className="prf-detalle">
                Servidor #{slot.index}
                {slot.map && ` · ${nombreDeMapa(slot.map)}`} · {slot.players ?? 0}/
                {slot.maxPlayers ?? 8}
              </p>
            </div>
            <button className="prf-btn prf-btn--activo" onClick={() => navegar('/mi-servidor')}>
              Ir a Mi servidor
            </button>
          </section>
        )}

        {enCola && (
          <section className="prf-card prf-card--cola">
            <div>
              <span className="prf-rotulo prf-rotulo--cola">⧗ EN COLA</span>
              <p className="prf-detalle">
                Posición #{me?.queue.position ?? 1}
                {estado?.queue.length ? ` · ${estado.queue.length} en total` : ''}
              </p>
            </div>
            <button className="prf-btn prf-btn--cola" onClick={() => navegar('/cola')}>
              Ver mi cola
            </button>
          </section>
        )}

        {!me?.slot && !enCola && (
          <p className="prf-idle">
            No tienes reservas ni cola ahora mismo. Tus datos vienen de Steam y se actualizan
            solos: aquí no hay nada que configurar.
          </p>
        )}

        <button className="prf-salir" onClick={() => void salir()}>
          Cerrar sesión
        </button>
      </main>
    </>
  )
}
