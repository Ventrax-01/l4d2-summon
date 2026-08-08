/* Cabecera pegajosa. Muestra accesos rápidos según el estado del usuario: si tiene un
   servidor abierto o un lugar en la cola, se llega en un toque desde cualquier pantalla. */

import { Link, useNavigate } from 'react-router-dom'
import { useFlota } from '@/context/FlotaContext'
import { iniciales } from '@/lib/formato'
import './Cabecera.css'

export default function Cabecera() {
  const { estado } = useFlota()
  const navegar = useNavigate()
  const me = estado?.me

  return (
    <header className="cab">
      <div className="cab-int">
        <Link to="/" className="cab-marca">
          <span className="cab-logo" aria-hidden="true">
            V
          </span>
          <span className="cab-titulo">
            <strong>VENTRAX</strong>
            <small>L4D2 SERVERS</small>
          </span>
        </Link>

        <nav className="cab-acc">
          {me?.slot && (
            <button className="cab-chip cab-chip--mio" onClick={() => navegar('/mi-servidor')}>
              <span className="cab-punto" aria-hidden="true" />
              Mi servidor
            </button>
          )}

          {me?.queue.inQueue && (
            <button className="cab-chip cab-chip--cola" onClick={() => navegar('/cola')}>
              <span aria-hidden="true">⧗</span> Cola
              {me.queue.position ? ` #${me.queue.position}` : ''}
            </button>
          )}

          {me ? (
            <button className="cab-perfil" onClick={() => navegar('/perfil')} title="Perfil">
              <span className="cab-nick">R4zor</span>
              <span className="cab-avatar" aria-hidden="true">
                {iniciales('R4zor')}
              </span>
            </button>
          ) : (
            <button className="cab-entrar" onClick={() => navegar('/entrar')}>
              Entrar con Steam
            </button>
          )}
        </nav>
      </div>
    </header>
  )
}
