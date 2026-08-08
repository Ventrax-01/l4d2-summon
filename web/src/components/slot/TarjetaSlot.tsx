/* Tarjeta de servidor.

   Estructura tomada del prototipo: el chip de estado va SOBRE la miniatura en los
   estados que la tienen (libre, preparando, activo) y baja a la fila del cuerpo solo
   cuando no hay miniatura (error, reservado para la cola).

   El estado nunca se comunica solo con color: siempre lleva icono y etiqueta. */

import type { Slot } from '@/types'
import { visualDe } from './estadoVisual'
import { desdeHace, gradienteMapa, imagenDeMapa, iniciales, nombreDeMapa } from '@/lib/formato'
import { capituloDe } from '@/lib/mapas'
import './TarjetaSlot.css'

interface Props {
  slot: Slot
  mio?: boolean
  onReservar?: () => void
  onGestionar?: () => void
}

export default function TarjetaSlot({ slot, mio = false, onReservar, onGestionar }: Props) {
  const v = visualDe(slot.estado)
  const enJuego = slot.estado === 'ACTIVO' || slot.estado === 'VACIO'
  const libre = slot.estado === 'LIBRE'
  const preparando = slot.estado === 'PREPARANDO'
  const conError = slot.estado === 'ERROR'
  const lleno = Boolean(slot.players && slot.maxPlayers && slot.players >= slot.maxPlayers)
  const mapa = nombreDeMapa(slot.map)

  const conMiniatura = enJuego || libre || preparando
  // Con miniatura el chip va encima; si no, baja a la fila del cuerpo.
  const chipEnCuerpo = !conMiniatura && Boolean(v.etiqueta)

  return (
    <article className="tsl" data-estado={slot.estado}>
      {conMiniatura && (
        <div
          className={`tsl-mapa ${libre ? 'tsl-mapa--atenuado' : ''} ${preparando ? 'tsl-mapa--prep' : ''}`}
          style={
            {
              '--grad': gradienteMapa(slot.map),
              // La imagen va como capa encima del degradado: si falta el archivo,
              // el degradado sigue ahí y la tarjeta no se rompe.
              '--img': imagenDeMapa(slot.map) ? `url(${imagenDeMapa(slot.map)})` : 'none',
            } as React.CSSProperties
          }
          role="img"
          aria-label={mapa ? `Mapa ${mapa}` : 'Servidor sin partida'}
        >
          <span className="tsl-mapa-trama" aria-hidden="true" />
          {v.etiqueta && (
            <span
              className="tsl-badge"
              style={{ '--c': `var(${v.color})` } as React.CSSProperties}
            >
              <span aria-hidden="true">{v.icono}</span> {v.etiqueta}
            </span>
          )}

          {mapa && (
            <span className={`tsl-mapa-nombre ${libre ? 'tsl-mapa-nombre--tenue' : ''}`}>
              {libre ? `Próximo mapa · ${mapa}` : mapa}
            </span>
          )}
        </div>
      )}

      <div className="tsl-cuerpo">
        <div className="tsl-fila">
          <h3 className="tsl-nombre">
            SERVIDOR #{slot.index}
            {mio && <span className="tsl-tuyo">TUYO</span>}
          </h3>

          {(enJuego || libre) && (
            <span className={`tsl-jugadores ${libre ? 'tsl-jugadores--vacio' : ''}`}>
              <span aria-hidden="true">👥</span> {slot.players ?? 0}/{slot.maxPlayers ?? 8}
            </span>
          )}

          {chipEnCuerpo && (
            <span
              className="tsl-chip"
              style={{ '--c': `var(${v.color})` } as React.CSSProperties}
            >
              <span aria-hidden="true">{v.icono}</span> {v.etiqueta}
            </span>
          )}
        </div>

        {/* El chip sobre la miniatura vive dentro de un role="img": los lectores de
            pantalla no leen su contenido, así que ahí hace falta el texto alternativo. */}
        {conMiniatura && <span className="solo-lectores">{v.descripcion}</span>}

        {slot.map && (
          <p className="tsl-mapa-linea">
            <span className="tsl-capitulo">{capituloDe(slot.map)}</span>
            <code className="tsl-codigo">{slot.map}</code>
          </p>
        )}

        {libre && <p className="tsl-sub">Disponible — resérvalo y juega.</p>}

        {slot.estado === 'RESERVADO_COLA' && (
          <p className="tsl-sub">Guardado para el siguiente de la cola.</p>
        )}

        {conError && <p className="tsl-sub">Este servidor no pudo prepararse. Ya estamos en ello.</p>}

        {preparando && (
          <>
            <p className="tsl-sub">
              {mio ? 'Tu servidor se está preparando…' : 'Alguien lo está reservando ahora mismo…'}
            </p>
            <div className="tsl-barra" role="progressbar" aria-label="Preparando servidor">
              <span />
            </div>
          </>
        )}

        {enJuego && slot.ownerNick && (
          <div className="tsl-dueno">
            {slot.ownerAvatar ? (
              <img className="tsl-avatar tsl-avatar--foto" src={slot.ownerAvatar} alt="" />
            ) : (
              <span className="tsl-avatar" aria-hidden="true">
                {iniciales(slot.ownerNick)}
              </span>
            )}
            <span className="tsl-dueno-nick">{slot.ownerNick}</span>
            {slot.since && <span className="tsl-dueno-desde">· {desdeHace(slot.since)}</span>}
          </div>
        )}

        {libre && (
          <button className="tsl-btn tsl-btn--libre" onClick={onReservar}>
            Reservar este
          </button>
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
