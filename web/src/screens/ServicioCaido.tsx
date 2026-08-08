/* Pantalla global de servicio caído: no carga NADA, así que no tiene sentido enrutar.
   Es distinta del error de la lista (que sí deja usar el resto de la app). */

import { useFlota } from '@/context/FlotaContext'
import './ServicioCaido.css'

export default function ServicioCaido() {
  const { refrescar } = useFlota()

  return (
    <main className="caido">
      <span className="caido-ico" aria-hidden="true">
        🔌
      </span>
      <h1>No podemos conectar</h1>
      <p>
        El panel no está respondiendo ahora mismo. No es cosa tuya y suele durar poco;
        vuelve a intentarlo en un momento.
      </p>
      <button className="caido-btn" onClick={() => void refrescar()}>
        Reintentar
      </button>
    </main>
  )
}
