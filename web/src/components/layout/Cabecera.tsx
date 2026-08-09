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
          {/* Sale de la SPA: el panel de baneos es otra aplicación servida en esa ruta, así
              que va como enlace de verdad y no por el router. */}
          <a className="cab-chip cab-chip--bans" href="/sourcebans/">
            Baneos
          </a>

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
              <span className="cab-nick">{me.nick}</span>
              {/* Steam da la foto en el login y se guarda con la sesión. Las iniciales son
                  solo el respaldo para cuentas sin foto o si la imagen no carga. */}
              {me.avatar ? (
                <img className="cab-avatar cab-avatar--foto" src={me.avatar} alt="" />
              ) : (
                <span className="cab-avatar" aria-hidden="true">
                  {iniciales(me.nick)}
                </span>
              )}
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
