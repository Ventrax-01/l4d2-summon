/* Tarjeta de servidor.

   Traducida del prototipo. Cubre los estados que puede devolver el backend: libre,
   preparando, activo (con dueño, mapa y jugadores), vacío, reservado para la cola,
   cerrando y error. El CTA de reservar NO vive aquí: es el botón principal de la home. */

import type { Slot } from '@/types'
import { visualDe } from './estadoVisual'
import { desdeHace, iniciales, nombreDeMapa } from '@/lib/formato'
import './TarjetaSlot.css'

interface Props {
  slot: Slot
  /** true si el slot es del usuario en sesión. */
  mio?: boolean
  /** Errores por slot: el backend no los expone en el estado, los pone la UI. */
  conError?: boolean
  onGestionar?: () => void
  onReintentar?: () => void
  onAvisar?: () => void
}

export default function TarjetaSlot({
  slot,
  mio = false,
  conError = false,
  onGestionar,
  onReintentar,
  onAvisar,
}: Props) {
  const v = visualDe(slot.estado)
  const enJuego = slot.estado === 'ACTIVO' || slot.estado === 'VACIO'
  const lleno = Boolean(slot.players && slot.maxPlayers && slot.players >= slot.maxPlayers)
  const titulo = `Servidor #${slot.index}`

  if (conError) {
    return (
      <article className="tsl tsl--error">
        <div className="tsl-cuerpo">
          <div className="tsl-fila">
            <h3 className="tsl-nombre">{titulo}</h3>
            <span className="tsl-chip tsl-chip--error">⚠ ERROR</span>
          </div>
          <p className="tsl-sub">No pudimos preparar este servidor.</p>
          <div className="tsl-acciones">
            <button className="tsl-btn tsl-btn--contorno" onClick={onReintentar}>
              Reintentar
            </button>
            <button className="tsl-btn tsl-btn--texto" onClick={onAvisar}>
              Avisar al operador
            </button>
          </div>
        </div>
      </article>
    )
  }

  return (
    <article className="tsl" data-estado={slot.estado}>
      {enJuego && (
        <div className="tsl-mapa" role="img" aria-label={`Mapa ${nombreDeMapa(slot.map)}`}>
          <span className="tsl-mapa-trama" aria-hidden="true" />
          {slot.estado === 'ACTIVO' && (
            <span className="tsl-enjuego">
              <span className="tsl-punto" aria-hidden="true" />
              EN JUEGO
            </span>
          )}
          <span className="tsl-mapa-nombre">{nombreDeMapa(slot.map)}</span>
        </div>
      )}

      <div className="tsl-cuerpo">
        <div className="tsl-fila">
          <h3 className="tsl-nombre">
            {titulo}
            {mio && <span className="tsl-tuyo">TUYO</span>}
          </h3>

          {enJuego && slot.players != null && (
            <span className="tsl-jugadores">
              <span aria-hidden="true">👥</span> {slot.players}/{slot.maxPlayers ?? 8}
            </span>
          )}

          {v.etiqueta && (
            <span className="tsl-chip" style={{ '--c': `var(${v.color})` } as React.CSSProperties}>
              <span aria-hidden="true">{v.icono}</span> {v.etiqueta}
            </span>
          )}
        </div>

        {/* Cuando hay chip, su texto ya anuncia el estado. Cuando no lo hay (ACTIVO), la
            insignia "EN JUEGO" vive dentro de un role="img" y los lectores de pantalla no
            leen su contenido, así que hace falta el texto alternativo. */}
        {!v.etiqueta && <span className="solo-lectores">{v.descripcion}</span>}

        {slot.estado === 'LIBRE' && (
          <p className="tsl-sub">Disponible — resérvalo y juega.</p>
        )}

        {slot.estado === 'RESERVADO_COLA' && (
          <p className="tsl-sub">Guardado para el siguiente de la cola.</p>
        )}

        {slot.estado === 'PREPARANDO' && (
          <>
            <p className="tsl-sub">Alguien lo está preparando…</p>
            <div className="tsl-barra" role="progressbar" aria-label="Preparando servidor">
              <span />
            </div>
          </>
        )}

        {enJuego && slot.ownerNick && (
          <div className="tsl-dueno">
            <span className="tsl-avatar" aria-hidden="true">
              {iniciales(slot.ownerNick)}
            </span>
            <span className="tsl-dueno-nick">{slot.ownerNick}</span>
            {slot.since && <span className="tsl-dueno-desde">· {desdeHace(slot.since)}</span>}
          </div>
        )}

        {enJuego &&
          (mio ? (
            <button className="tsl-btn tsl-btn--mio" onClick={onGestionar}>
              Gestionar mi servidor
            </button>
          ) : lleno ? (
            <button className="tsl-btn" disabled>
              Servidor lleno
            </button>
          ) : (
            <a className="tsl-btn tsl-btn--contorno" href={slot.connect}>
              Entrar a jugar
            </a>
          ))}
      </div>
    </article>
  )
}
