/* Stepper de preparación.

   El backend manda el stepper ya calculado ({total, current, labels}), así que esta
   pantalla no conoce los estados internos de la máquina: solo pinta celdas. Eso permite
   que existan dos duraciones (con y sin la etapa de encendido) sin ramas aquí.

   El copy nunca menciona infraestructura: para el usuario esto es "preparar tu servidor". */

import type { Stepper as DatosStepper } from '@/types'
import './Stepper.css'

/** Microcopy por etapa. La clave es la etiqueta que manda el backend. */
const MICRO: Record<string, string> = {
  Despertando: 'Encendiendo tu servidor…',
  Iniciando: 'Arrancando y cargando el mapa…',
  Verificando: 'Comprobando que todo responde y dándote tus permisos…',
  '¡Listo!': 'Tu servidor está arriba.',
}

interface Props {
  datos: DatosStepper
  /** Si el intent falló, la celda actual se marca en rojo en vez de en curso. */
  fallido?: boolean
}

export default function Stepper({ datos, fallido = false }: Props) {
  return (
    <ol className="stp" aria-label="Progreso de la preparación">
      {datos.labels.map((label, i) => {
        const n = i + 1
        const hecho = n < datos.current
        const actual = n === datos.current
        const falla = actual && fallido
        const ultimo = n === datos.labels.length

        return (
          <li key={label} className="stp-paso">
            <div className="stp-carril">
              <span
                className={
                  'stp-punto ' +
                  (hecho
                    ? 'stp-punto--hecho'
                    : falla
                      ? 'stp-punto--falla'
                      : actual
                        ? 'stp-punto--actual'
                        : 'stp-punto--pend')
                }
                aria-hidden="true"
              >
                {hecho ? '✓' : falla ? '!' : actual ? <span className="stp-nucleo" /> : n}
              </span>
              {!ultimo && (
                <span
                  className="stp-linea"
                  style={{ background: hecho ? 'var(--accent)' : 'var(--border)' }}
                  aria-hidden="true"
                />
              )}
            </div>

            <div className="stp-texto">
              <p
                className={
                  'stp-label ' +
                  (falla ? 'stp-label--falla' : actual ? 'stp-label--actual' : hecho ? 'stp-label--hecho' : '')
                }
              >
                {label}
              </p>
              {MICRO[label] && (
                <p className={'stp-micro ' + (hecho ? 'stp-micro--hecho' : actual ? '' : 'stp-micro--pend')}>
                  {hecho ? MICRO[label].replace('…', '… hecho') : MICRO[label]}
                </p>
              )}
              {actual && !fallido && (
                <div className="stp-barra" aria-hidden="true">
                  <span />
                </div>
              )}
            </div>

            {/* Estado textual para lectores de pantalla. */}
            <span className="solo-lectores">
              {hecho ? 'completado' : falla ? 'falló' : actual ? 'en curso' : 'pendiente'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
