/* Tarjeta de servidor.

   Cada estado que puede devolver el backend tiene su presentación: libre, preparando,
   activo, vacío, reservado para la cola, cerrando y error. El estado nunca se comunica
   solo con color — siempre lleva icono y etiqueta de texto.

   La miniatura del mapa se servirá desde el CDN; por ahora es un degradado con el rótulo
   que marca dónde irá la imagen. */

import type { Slot } from '@/types'
import { visualDe } from './estadoVisual'
import { desdeHace, iniciales, nombreDeMapa } from '@/lib/formato'
import './TarjetaSlot.css'

interface Props {
  slot: Slot
  mio?: boolean
  /** Reservar este servidor concreto (no "uno cualquiera"). */
  onReservar?: () => void
  onGestionar?: () => void
  onReintentar?: () => void
  onAvisar?: () => void
}

export default function TarjetaSlot({
  slot,
  mio = false,
  onReservar,
  onGestionar,
  onReintentar,
  onAvisar,
}: Props) {
  const v = visualDe(slot.estado)
  const enJuego = slot.estado === 'ACTIVO' || slot.estado === 'VACIO'
  const libre = slot.estado === 'LIBRE'
  const preparando = slot.estado === 'PREPARANDO'
  const conError = slot.estado === 'ERROR'
  const lleno = Boolean(slot.players && slot.maxPlayers && slot.players >= slot.maxPlayers)
  const titulo = `Servidor #${slot.index}`
  const mapa = nombreDeMapa(slot.map)

  // El error no muestra miniatura: no hay partida que enseñar.
  const conMiniatura = (enJuego || libre || preparando) && !conError

  return (
    <article className="tsl" data-estado={slot.estado}>
      {conMiniatura && (
        <div
          className={`tsl-mapa ${libre ? 'tsl-mapa--atenuado' : ''} ${preparando ? 'tsl-mapa--prep' : ''}`}
          role="img"
          aria-label={mapa ? `Mapa ${mapa}` : 'Servidor sin partida'}
        >
          <span className="tsl-mapa-trama" aria-hidden="true" />
          <span className="tsl-mapa-cdn" aria-hidden="true">
            IMAGEN MAPA · CDN
          </span>

          {slot.estado === 'ACTIVO' && (
            <span className="tsl-badge tsl-badge--juego">
              <span className="tsl-punto" aria-hidden="true" />
              EN JUEGO
            </span>
          )}

          {mapa && (
            <span className="tsl-mapa-nombre">
              {libre ? `Próximo mapa · ${mapa}` : mapa}
            </span>
          )}
        </div>
      )}

      <div className="tsl-cuerpo">
        <div className="tsl-fila">
          <h3 className="tsl-nombre">
            {titulo}
            {mio && <span className="tsl-tuyo">TUYO</span>}
          </h3>

          {(enJuego || libre) && (
            <span className={`tsl-jugadores ${libre ? 'tsl-jugadores--vacio' : ''}`}>
              <span aria-hidden="true">👥</span> {slot.players ?? 0}/{slot.maxPlayers ?? 8}
            </span>
          )}

          {v.etiqueta && (
            <span
              className={`tsl-chip ${preparando ? 'tsl-chip--pulso' : ''}`}
              style={{ '--c': `var(${v.color})` } as React.CSSProperties}
            >
              <span aria-hidden="true">{v.icono}</span> {v.etiqueta}
            </span>
          )}
        </div>

        {/* Cuando no hay chip (ACTIVO), la insignia vive dentro de un role="img" y los
            lectores de pantalla no leen su contenido: hace falta el texto alternativo. */}
        {!v.etiqueta && <span className="solo-lectores">{v.descripcion}</span>}

        {libre && <p className="tsl-sub">Disponible — resérvalo y juega.</p>}

        {slot.estado === 'RESERVADO_COLA' && (
          <p className="tsl-sub">Guardado para el siguiente de la cola.</p>
        )}

        {conError && <p className="tsl-sub">No pudo prepararse. Ya estamos en ello.</p>}

        {preparando && (
          <>
            <p className="tsl-sub">Alguien lo está reservando ahora mismo…</p>
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
            {slot.since && <span className="tsl-dueno-desde">· hace {desdeHace(slot.since)}</span>}
          </div>
        )}

        {/* --- Acción --- */}
        {libre && (
          <button className="tsl-btn tsl-btn--libre" onClick={onReservar}>
            Reservar este
          </button>
        )}

        {conError && (
          <div className="tsl-acciones">
            <button className="tsl-btn tsl-btn--contorno" onClick={onReintentar}>
              Reintentar
            </button>
            <button className="tsl-btn tsl-btn--texto" onClick={onAvisar}>
              Avisar al operador
            </button>
          </div>
        )}

        {enJuego &&
          (mio ? (
            <button className="tsl-btn tsl-btn--mio" onClick={onGestionar}>
              Ir a Mi servidor
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

        {preparando && mio && (
          <button className="tsl-btn tsl-btn--mio" onClick={onGestionar}>
            Ver progreso
          </button>
        )}
      </div>
    </article>
  )
}
