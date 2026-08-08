/* Home: la lista de servidores. Es PÚBLICA — se ve sin sesión y cualquiera puede entrar
   a jugar a un servidor abierto. Reservar sí exige sesión. */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clienteApi } from '@/api'
import { useFlota } from '@/context/FlotaContext'
import Cabecera from '@/components/layout/Cabecera'
import TarjetaSlot from '@/components/slot/TarjetaSlot'
import EsqueletoFlota from '@/components/ui/EsqueletoFlota'
import './Home.css'

export default function Home() {
  const { estado, cargando, error, refrescar } = useFlota()
  const [reservando, setReservando] = useState(false)
  const navegar = useNavigate()

  const me = estado?.me
  const slots = estado?.slots ?? []
  const libres = slots.filter((s) => s.estado === 'LIBRE').length
  const ocupados = slots.length - libres

  async function reservar() {
    if (!me) {
      navegar('/entrar')
      return
    }
    setReservando(true)
    try {
      const intent = await clienteApi.reservar()
      await refrescar()
      navegar(intent.estado === 'EN_COLA' ? '/cola' : '/reservar')
    } catch {
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
        <div className="home-cab">
          <h1 className="home-titulo">Servidores</h1>
          {!error && slots.length > 0 && (
            <p className="home-conteo">
              <span className="home-punto home-punto--libre" aria-hidden="true" />
              {libres} {libres === 1 ? 'libre' : 'libres'}
              <span className="home-sep" aria-hidden="true">
                ·
              </span>
              <span className="home-punto home-punto--ocupado" aria-hidden="true" />
              {ocupados} {ocupados === 1 ? 'ocupado' : 'ocupados'}
            </p>
          )}
        </div>

        {error ? (
          <section className="home-error" role="alert">
            <span className="home-error-ico" aria-hidden="true">
              ⚠
            </span>
            <h2>La lista no cargó</h2>
            <p>No pudimos traer los servidores. Suele resolverse al momento.</p>
            <button className="home-cta" onClick={() => void refrescar()}>
              Reintentar
            </button>
          </section>
        ) : (
          <>
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

            {slots.length > 0 ? (
              <div className="home-rejilla">
                {slots.map((s) => (
                  <TarjetaSlot
                    key={s.index}
                    slot={s}
                    mio={me?.slot?.index === s.index}
                    onGestionar={() => navegar('/mi-servidor')}
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
              </section>
            )}

            <aside className="home-nota">
              <span aria-hidden="true">🌙</span>
              <p>
                Los servidores se cierran solos cuando quedan vacíos un rato. Así siempre hay
                sitio para el siguiente. 1 servidor por persona; todos son públicos.
              </p>
            </aside>
          </>
        )}
      </main>
    </>
  )
}
