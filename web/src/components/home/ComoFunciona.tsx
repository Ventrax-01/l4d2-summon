/* "Cómo funciona": tres pasos para quien llega por primera vez.

   Resume las reglas que de otro modo sorprenden — uno por persona, la espera es normal,
   y el servidor se cierra solo. Los iconos son SVG en línea, como en el diseño: los
   glifos de emoji cambian de forma según el sistema y aquí importa que sean idénticos. */

import './ComoFunciona.css'

function IconoRayo() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M13 2L4.5 13.5H11L10 22L19.5 9.5H13L13 2Z"
        stroke="#28D8FF"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="rgba(40,216,255,.08)"
      />
    </svg>
  )
}

function IconoReloj() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="13" r="8" stroke="#28D8FF" strokeWidth="1.6" fill="rgba(40,216,255,.08)" />
      <path d="M12 9v4l2.8 2" stroke="#28D8FF" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9.5 3h5" stroke="#28D8FF" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconoMando() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="2.5"
        y="8"
        width="19"
        height="10"
        rx="5"
        stroke="#28D8FF"
        strokeWidth="1.6"
        fill="rgba(40,216,255,.08)"
      />
      <path d="M7.5 11.5v3M6 13h3" stroke="#28D8FF" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16" cy="12" r="1" fill="#28D8FF" />
      <circle cx="18.5" cy="14.5" r="1" fill="#28D8FF" />
    </svg>
  )
}

const PASOS = [
  {
    Icono: IconoRayo,
    titulo: 'Reserva un servidor',
    texto: 'Pulsa el botón y listo, no hay que configurar nada. Un servidor por persona.',
  },
  {
    Icono: IconoReloj,
    titulo: 'Espera a que arranque',
    texto: 'Tarda unos minutos como mucho; te avisamos cuando esté listo.',
  },
  {
    Icono: IconoMando,
    titulo: 'Conéctate con tu grupo',
    texto:
      'Comparte la dirección: cualquiera puede unirse. Tú mandas mientras juegas. Si queda vacío un rato, se cierra solo.',
  },
]

export default function ComoFunciona() {
  return (
    <section className="cf" aria-labelledby="cf-titulo">
      <div className="cf-divisor">
        <span className="cf-linea" aria-hidden="true" />
        <span id="cf-titulo" className="cf-rotulo">
          CÓMO FUNCIONA
        </span>
        <span className="cf-linea" aria-hidden="true" />
      </div>

      <ol className="cf-lista">
        <span className="cf-espina" aria-hidden="true" />
        {PASOS.map(({ Icono, titulo, texto }, i) => (
          <li key={titulo} className={`cf-paso ${i % 2 === 1 ? 'cf-paso--der' : ''}`}>
            <div className="cf-tarjeta">
              <Icono />
              <div className="cf-texto">
                <h3 className="cf-titulo">{titulo}</h3>
                <span className="cf-desc">{texto}</span>
              </div>
            </div>
            <span className="cf-badge" aria-hidden="true">
              {i + 1}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
