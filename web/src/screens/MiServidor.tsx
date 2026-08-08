/* Mi servidor: la vista del servidor que tengo reservado.
   Repite el botón de conectar y la dirección copiable porque es donde el usuario vuelve
   cuando ya cerró la pantalla de entrega. */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clienteApi } from '@/api'
import { useFlota } from '@/context/FlotaContext'
import Cabecera from '@/components/layout/Cabecera'
import Modal from '@/components/ui/Modal'
import { comandoConnect, desdeHace, nombreDeMapa } from '@/lib/formato'
import './MiServidor.css'

export default function MiServidor() {
  const { estado, refrescar } = useFlota()
  const navegar = useNavigate()
  const [copiado, setCopiado] = useState(false)
  const [abriendoAdmin, setAbriendoAdmin] = useState(false)
  const [confirmando, setConfirmando] = useState(false)

  const me = estado?.me
  const slot = estado?.slots.find((s) => s.index === me?.slot?.index)

  if (!me?.slot || !slot) {
    return (
      <>
        <Cabecera />
        <main className="mis mis--vacio">
          <span className="mis-vacio-ico" aria-hidden="true">
            🎮
          </span>
          <h1>No tienes servidor ahora</h1>
          <p>Reserva uno y en unos minutos estás jugando. Recuerda: 1 servidor por persona.</p>
          <button className="mis-reservar" onClick={() => navegar('/')}>
            Reservar servidor
          </button>
        </main>
      </>
    )
  }

  const comando = comandoConnect(me.slot.connect)

  async function copiar() {
    try {
      await navigator.clipboard.writeText(comando)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1800)
    } catch {
      /* sin portapapeles disponible: el texto se puede seleccionar a mano */
    }
  }

  async function cerrar() {
    setConfirmando(false)
    await clienteApi.cerrar()
    await refrescar()
    navegar('/')
  }

  return (
    <>
      <Cabecera />
      <main className="mis">
        <div className="mis-cab">
          <h1>Mi servidor</h1>
          <span className="mis-estado">
            <span className="mis-punto" aria-hidden="true" />
            {slot.estado === 'VACIO' ? 'SIN GENTE' : 'EN JUEGO'}
          </span>
        </div>

        <section className="mis-tarjeta">
          <div className="mis-mapa" role="img" aria-label={`Mapa ${nombreDeMapa(slot.map)}`}>
            <span className="mis-mapa-trama" aria-hidden="true" />
            <span className="mis-mapa-nombre">{nombreDeMapa(slot.map)}</span>
          </div>
          <div className="mis-datos">
            <strong>Servidor #{slot.index}</strong>
            <span className="mis-meta">
              <span>
                <span aria-hidden="true">👥</span> {slot.players ?? 0}/{slot.maxPlayers ?? 8}
              </span>
              {slot.since && <span className="mis-uptime">{desdeHace(slot.since)}</span>}
            </span>
          </div>
        </section>

        <a className="mis-conectar" href={me.slot.connect}>
          <span aria-hidden="true">▶</span> Conectar
        </a>

        <div className="mis-dir">
          <code>{comando}</code>
          <button onClick={() => void copiar()} title="Copiar dirección" aria-label="Copiar dirección">
            {copiado ? '✓' : '⧉'}
          </button>
        </div>

        <section className="mis-admin">
          <button
            className="mis-admin-cab"
            onClick={() => setAbriendoAdmin((v) => !v)}
            aria-expanded={abriendoAdmin}
          >
            <span className="mis-admin-tit">
              <span aria-hidden="true">🛡</span> Tus poderes de admin
              <small>kick · mapa · partida</small>
            </span>
            <span aria-hidden="true">{abriendoAdmin ? '▴' : '▾'}</span>
          </button>
          {abriendoAdmin && (
            <ul className="mis-admin-lista">
              <li>
                <span className="mis-si" aria-hidden="true">
                  ✓
                </span>
                Expulsar jugadores (kick)
              </li>
              <li>
                <span className="mis-si" aria-hidden="true">
                  ✓
                </span>
                Cambiar de mapa
              </li>
              <li>
                <span className="mis-si" aria-hidden="true">
                  ✓
                </span>
                Controlar la partida (reiniciar, pausar…)
              </li>
              <li className="mis-no">
                <span aria-hidden="true">✕</span>
                Banear — eso no está en tus manos
              </li>
            </ul>
          )}
        </section>

        <aside className="mis-nota">
          <span aria-hidden="true">🌙</span>
          <p>
            Público: cualquiera puede entrar con la dirección. Se cierra solo si queda vacío un
            rato.
          </p>
        </aside>

        <button className="mis-cerrar" onClick={() => setConfirmando(true)}>
          Cerrar servidor
        </button>
      </main>

      {confirmando && (
        <Modal
          titulo="¿Cerrar tu servidor?"
          textoConfirmar="Sí, cerrar servidor"
          textoCancelar="No, seguir jugando"
          onConfirmar={() => void cerrar()}
          onCancelar={() => setConfirmando(false)}
        >
          {slot.players && slot.players > 0 ? (
            <>
              Hay {slot.players} {slot.players === 1 ? 'persona jugando' : 'personas jugando'}: se
              desconectarán. El sitio pasará al siguiente de la cola y podrás reservar otro cuando
              quieras.
            </>
          ) : (
            <>
              El sitio pasará al siguiente de la cola. Podrás reservar otro cuando quieras.
            </>
          )}
        </Modal>
      )}
    </>
  )
}
