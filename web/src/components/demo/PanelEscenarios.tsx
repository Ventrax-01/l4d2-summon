/* Panel de escenarios — solo visible en modo mock.

   Es el equivalente al panel de "Tweaks" del prototipo del diseño: permite saltar entre
   estados de la aplicación sin backend. No se compila en el build real porque en modo
   http el componente no se monta. */

import { useEffect, useState } from 'react'
import { esModoMock } from '@/api'
import {
  fijarEscenario,
  obtenerEscenario,
  reiniciarEscenario,
  suscribirEscenario,
  type Escenario,
} from '@/api/mock/escenarios'
import { useFlota } from '@/context/FlotaContext'
import './PanelEscenarios.css'

const VELOCIDADES: Escenario['velocidad'][] = [1, 5, 20]

export default function PanelEscenarios() {
  const [abierto, setAbierto] = useState(false)
  const [esc, setEsc] = useState<Escenario>(obtenerEscenario())
  const { refrescar } = useFlota()

  useEffect(() => suscribirEscenario(setEsc), [])

  if (!esModoMock) return null

  /** Cada cambio rehace el mundo del motor; hay que releer para verlo al instante. */
  const cambiar = (cambios: Partial<Escenario>) => {
    fijarEscenario(cambios)
    void refrescar()
  }

  if (!abierto) {
    return (
      <button className="pe-abrir" onClick={() => setAbierto(true)} title="Escenarios de prueba">
        demo
      </button>
    )
  }

  return (
    <aside className="pe" aria-label="Escenarios de prueba">
      <header className="pe-cab">
        <strong>Escenarios</strong>
        <button onClick={() => setAbierto(false)} aria-label="Cerrar panel">
          ✕
        </button>
      </header>

      <label className="pe-fila">
        <span>Servidores: {esc.numServidores}</span>
        <input
          type="range"
          min={1}
          max={8}
          value={esc.numServidores}
          onChange={(ev) => cambiar({ numServidores: Number(ev.target.value) })}
        />
      </label>

      <div className="pe-fila">
        <span>Velocidad</span>
        <div className="pe-grupo">
          {VELOCIDADES.map((v) => (
            <button
              key={v}
              className={esc.velocidad === v ? 'act' : ''}
              onClick={() => fijarEscenario({ velocidad: v })}
            >
              x{v}
            </button>
          ))}
        </div>
      </div>

      <div className="pe-fila">
        <span>Sistema</span>
        <div className="pe-grupo">
          <button
            className={esc.hostInicial === 'DOWN' ? 'act' : ''}
            onClick={() => cambiar({ hostInicial: 'DOWN' })}
          >
            dormido (~3 min)
          </button>
          <button
            className={esc.hostInicial === 'UP' ? 'act' : ''}
            onClick={() => cambiar({ hostInicial: 'UP' })}
          >
            despierto (~45 s)
          </button>
        </div>
      </div>

      {(
        [
          ['todosOcupados', 'Todos ocupados (cola)'],
          ['fallaPreparacion', 'Falla la preparación'],
          ['errorDeLista', 'Error al cargar la lista'],
          ['backendCaido', 'Servicio caído'],
          ['loginFalla', 'Falla el login'],
          ['sesionIniciada', 'Con sesión iniciada'],
        ] as const
      ).map(([clave, etiqueta]) => (
        <label key={clave} className="pe-check">
          <input
            type="checkbox"
            checked={Boolean(esc[clave])}
            onChange={(ev) => cambiar({ [clave]: ev.target.checked } as Partial<Escenario>)}
          />
          <span>{etiqueta}</span>
        </label>
      ))}

      <button
        className="pe-reset"
        onClick={() => {
          reiniciarEscenario()
          void refrescar()
        }}
      >
        Reiniciar escenario
      </button>
    </aside>
  )
}
