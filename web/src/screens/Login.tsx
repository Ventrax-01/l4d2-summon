/* Login: un solo camino de entrada, "Entrar con Steam".
   No hay registro aparte — el mismo botón sirve para nuevos y recurrentes. */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clienteApi } from '@/api'
import { useFlota } from '@/context/FlotaContext'
import './Login.css'

export default function Login() {
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(false)
  const navegar = useNavigate()
  const { refrescar } = useFlota()

  async function entrar() {
    setCargando(true)
    setError(false)
    try {
      await clienteApi.entrarConSteam()
      await refrescar()
      navegar('/', { replace: true })
    } catch {
      setError(true)
    } finally {
      setCargando(false)
    }
  }

  return (
    <main className="login">
      <div className="login-hero">
        <span className="login-logo" aria-hidden="true">
          V
        </span>
        <h1 className="login-marca">VENTRAX</h1>
        <p className="login-sub">L4D2 SERVERS</p>
        <p className="login-claim">Reserva un servidor y juega al instante.</p>
      </div>

      <div className="login-acc">
        {error && (
          <div className="login-error" role="alert">
            <span aria-hidden="true">⚠</span>
            <span>No pudimos iniciar sesión con Steam. Vuelve a intentarlo.</span>
          </div>
        )}

        <button className="login-btn" onClick={entrar} disabled={cargando} aria-busy={cargando}>
          {cargando ? (
            <>
              <span className="login-spin" aria-hidden="true" />
              Conectando con Steam…
            </>
          ) : (
            <>
              <SteamIcono />
              Entrar con Steam
            </>
          )}
        </button>

        <p className="login-nota">Acceso abierto: cualquiera con cuenta de Steam entra y juega.</p>
      </div>
    </main>
  )
}

function SteamIcono() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <circle cx="15.5" cy="8.5" r="2.4" fill="currentColor" />
      <path d="M4 14l7-2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="9" cy="15" r="2" fill="currentColor" />
    </svg>
  )
}
