/* Home: la lista de servidores. Es PÚBLICA — se ve sin sesión y cualquiera puede entrar
   a jugar a un servidor abierto. Reservar sí exige sesión.

   Además de la rejilla, explica el producto a quien llega por primera vez: el hero dice
   qué va a pasar y la sección "cómo funciona" resume las tres reglas que importan. */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clienteApi } from '@/api'
import { useFlota } from '@/context/FlotaContext'
import { useToasts } from '@/components/ui/Toasts'
import Cabecera from '@/components/layout/Cabecera'
import TarjetaSlot from '@/components/slot/TarjetaSlot'
import EsqueletoFlota from '@/components/ui/EsqueletoFlota'
import ComoFunciona from '@/components/home/ComoFunciona'
import { ErrorApi } from '@/types'
import './Home.css'

export default function Home() {
  const { estado, cargando, error, refrescar } = useFlota()
  const { mostrar } = useToasts()
  const [reservando, setReservando] = useState(false)
  const navegar = useNavigate()

  const me = estado?.me
  const slots = estado?.slots ?? []
  const libres = slots.filter((s) => s.estado === 'LIBRE').length
  const preparando = slots.filter((s) => s.estado === 'PREPARANDO').length
  const enJuego = slots.filter((s) => s.estado === 'ACTIVO' || s.estado === 'VACIO').length

  async function reservar() {
    if (!me) {
      navegar('/entrar')
      return
    }
    // Con un servidor ya activo no tiene sentido pedir otro: es 1 por persona.
    if (me.slot) {
      mostrar('Ya tienes un servidor activo. Ciérralo antes de reservar otro.', 'info')
      navegar('/mi-servidor')
      return
    }
    // Con una reserva en curso, volver a su progreso.
    if (me.intent && !['LISTO', 'FALLIDO', 'CANCELADO', 'EXPIRADO'].includes(me.intent.estado)) {
      navegar(me.intent.estado === 'EN_COLA' ? '/cola' : '/reservar')
      return
    }

    setReservando(true)
    try {
      const intent = await clienteApi.reservar()
      await refrescar()
      navegar(intent.estado === 'EN_COLA' ? '/cola' : '/reservar')
    } catch (e) {
      if (e instanceof ErrorApi && e.codigo === 'COOLDOWN') {
        mostrar('Espera unos segundos antes de reservar de nuevo.', 'warn')
      } else {
        mostrar('No pudimos reservar. Inténtalo otra vez.', 'error')
      }
      await refrescar()
    } finally {
      setReservando(false)
    }
  }

  if (cargando && !estado) {
    return (
      <>
        <Cabecera />
        <EsqueletoFlota />
        </>
    )
  }

  return (
    <>
      <Cabecera />
      <main className="home">
        {error ? (
          <section className="home-error" role="alert">
            <span className="home-error-ico" aria-hidden="true">
              ⚠
            </span>
            <h2>La lista no cargó</h2>
            <p>No pudimos traer los servidores. Suele resolverse al momento.</p>
            <button className="home-cta home-cta--chico" onClick={() => void refrescar()}>
              Reintentar
            </button>
          </section>
        ) : (
          <>
            <section className="hero">
              <div className="hero-texto">
                <h1>Reserva y juega en minutos</h1>
                <p>Pulsa el botón, espera la preparación y conéctate. Sin configurar nada.</p>
                <ul className="hero-conteo">
                  <li>
                    <strong className="hero-num hero-num--libre">{libres}</strong>
                    <span>LIBRES</span>
                  </li>
                  <li>
                    <strong className="hero-num hero-num--prep">{preparando}</strong>
                    <span>PREPARANDO</span>
                  </li>
                  <li>
                    <strong className="hero-num hero-num--juego">{enJuego}</strong>
                    <span>EN JUEGO</span>
                  </li>
                </ul>
              </div>

              <div className="hero-accion">
                <button
                  className="home-cta"
                  onClick={() => void reservar()}
                  disabled={reservando}
                  aria-busy={reservando}
                >
                  <span aria-hidden="true">⚡</span>{' '}
                  {reservando ? 'Reservando…' : 'Reservar servidor'}
                </button>
                {!me && <p className="home-aviso-login">Te pediremos entrar con Steam primero.</p>}
              </div>
            </section>

            {slots.length > 0 ? (
              <div className="home-rejilla">
                {slots.map((s) => (
                  <TarjetaSlot
                    key={s.index}
                    slot={s}
                    mio={me?.slot?.index === s.index || me?.intent?.slotIndex === s.index}
                    onReservar={() => void reservar()}
                    onGestionar={() =>
                      navegar(me?.slot?.index === s.index ? '/mi-servidor' : '/reservar')
                    }
                    onReintentar={() => void refrescar()}
                    onAvisar={() => mostrar('Aviso enviado al operador. Gracias.', 'ok')}
                  />
                ))}
              </div>
            ) : (
              <section className="home-vacio">
                <span className="home-vacio-ico" aria-hidden="true">
                  🛰
                </span>
                <h2>No hay servidores ahora mismo</h2>
                <p>El operador aún no ha publicado ninguno. Vuelve en un rato.</p>
                <button className="home-cta home-cta--chico" onClick={() => void refrescar()}>
                  <span aria-hidden="true">↻</span> Actualizar
                </button>
              </section>
            )}

            <ComoFunciona />
          </>
        )}
      </main>
    </>
  )
}
