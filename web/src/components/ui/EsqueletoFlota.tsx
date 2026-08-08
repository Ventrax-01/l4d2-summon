/* Esqueleto de carga de la home. Reserva el mismo espacio que el contenido real para
   que no haya saltos de layout cuando llegan los datos. */

import './EsqueletoFlota.css'

export default function EsqueletoFlota() {
  return (
    <div className="esq" aria-busy="true" aria-label="Cargando servidores">
      <div className="esq-cab">
        <span className="esq-bloque esq-titulo" />
        <span className="esq-bloque esq-conteo" />
      </div>
      <span className="esq-bloque esq-cta" />
      <div className="esq-rejilla">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="esq-bloque esq-tarjeta" />
        ))}
      </div>
    </div>
  )
}
