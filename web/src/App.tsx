/* Rutas de la aplicación.

   La home es PÚBLICA: se ve la flota sin sesión y cualquiera puede conectarse a un
   servidor abierto. Solo reservar, cerrar y el perfil exigen sesión. */

import { Navigate, Route, Routes } from 'react-router-dom'
import { useFlota } from '@/context/FlotaContext'
import type { ReactElement } from 'react'

import PanelEscenarios from '@/components/demo/PanelEscenarios'
import PieGlobal from '@/components/layout/PieGlobal'
import Home from '@/screens/Home'
import Login from '@/screens/Login'
import Reservar from '@/screens/Reservar'
import MiServidor from '@/screens/MiServidor'
import Perfil from '@/screens/Perfil'
import Cola from '@/screens/Cola'
import ServicioCaido from '@/screens/ServicioCaido'

/** Envuelve rutas que necesitan sesión. Mientras carga el primer estado no se decide
    nada, para no expulsar a un usuario que sí tiene sesión. */
function Privada({ children }: { children: ReactElement }) {
  const { estado, cargando } = useFlota()
  if (cargando) return null
  if (!estado?.me) return <Navigate to="/entrar" replace />
  return children
}

export default function App() {
  const { error } = useFlota()

  // Si el servicio no responde en absoluto, no tiene sentido enrutar nada. El panel de
  // escenarios se monta igual: si no, activar "servicio caído" en modo mock dejaría la
  // app sin forma de desactivarlo.
  if (error?.codigo === 'BACKEND_DOWN') {
    return (
      <>
        <ServicioCaido />
        <PanelEscenarios />
      </>
    )
  }

  return (
    <div className="pagina">
      <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/entrar" element={<Login />} />
      <Route
        path="/reservar"
        element={
          <Privada>
            <Reservar />
          </Privada>
        }
      />
      <Route
        path="/mi-servidor"
        element={
          <Privada>
            <MiServidor />
          </Privada>
        }
      />
      <Route
        path="/cola"
        element={
          <Privada>
            <Cola />
          </Privada>
        }
      />
      <Route
        path="/perfil"
        element={
          <Privada>
            <Perfil />
          </Privada>
        }
      />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <PieGlobal />
      <PanelEscenarios />
    </div>
  )
}
