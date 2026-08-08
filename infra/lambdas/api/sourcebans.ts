/* La puerta al panel de baneos.

   El panel de SourceBans es PÚBLICO por diseño, y esa es su razón de ser: quien recibe un
   baneo puede ver por qué, apelarlo (`page.protest.php`), y cualquiera puede denunciar a un
   jugador (`page.submit.php`) o consultar la lista (`page.banlist.php`). Solo la
   administración —las páginas `admin.*`— pide contraseña, y de eso se encarga el propio
   panel con sus cuentas.

   Entonces, ¿qué pinta esta puerta? Una sola cosa: **encender la máquina**. El panel vive en
   casa y esa máquina duerme, así que sin ayuda estaría caído la mayor parte del tiempo. Pero
   el encendido no puede ser público — cualquiera podría mantener el equipo despierto sin más
   que recargar. Así que se enciende SOLO cuando quien pasa es el operador.

   Al resto se les manda al panel sin más, y si la máquina está dormida se les dice con
   claridad en vez de dejarles una redirección que no lleva a ninguna parte.

   Y el panel no se sirve a través de CloudFront a propósito: ese salto iría por internet
   entre el borde y la casa llevando contraseñas de administración y cookies de sesión. El
   navegador habla TLS directamente con la máquina. */

import { redirigir } from '../shared/http'
import * as m from '../shared/modelo'

const ESTILO = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101114;
color:#f2f4f8;font-family:ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px}
.c{max-width:34rem;display:flex;flex-direction:column;gap:14px}
h1{font-size:1.4rem;margin:0;font-weight:650}
p{margin:0;color:#9aa3b2;line-height:1.6}
a{color:#28d8ff}`

function html(cuerpo: string, estado = 200) {
  return {
    statusCode: estado,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: cuerpo,
  }
}

/** Se sirve mientras la máquina arranca y entra sola. Independiente de la SPA a propósito:
    tiene que funcionar aunque el resto del sitio falle. */
function paginaDespertando(destino: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Encendiendo el servidor…</title><style>${ESTILO}
.b{height:4px;border-radius:99px;background:#1b1f27;overflow:hidden}
.b>i{display:block;height:100%;width:35%;border-radius:99px;background:#28d8ff;
animation:v 1.4s ease-in-out infinite}
@keyframes v{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
@media (prefers-reduced-motion:reduce){.b>i{animation:none;width:100%}}</style></head>
<body><div class="c">
  <h1>Encendiendo el servidor</h1>
  <p>El panel de baneos vive en la máquina de casa, que estaba apagada.
     Suele tardar menos de un minuto.</p>
  <div class="b"><i></i></div>
  <p><small>Esta página se abre sola cuando esté lista.</small></p>
</div><script>
  var destino = ${JSON.stringify(destino)};
  setInterval(function () {
    fetch('/api/state', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (d) { if (d.host && d.host.state === 'UP') location.href = destino })
      .catch(function () {});
  }, 4000);
</script></body></html>`
}

/** Para quien no es operador y llega con la máquina dormida. Se le dice qué pasa y cuándo
    volver, en vez de mandarle a una dirección que no va a responder. */
function paginaDormida(): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>El panel no está disponible ahora</title><style>${ESTILO}</style></head>
<body><div class="c">
  <h1>El panel no está disponible ahora</h1>
  <p>La lista de baneos vive en el mismo equipo que los servidores, y ese equipo se apaga
     cuando no hay nadie jugando. Vuelve a intentarlo cuando haya alguna partida en marcha.</p>
  <p><a href="/">Ver el estado de los servidores</a></p>
</div></body></html>`
}

interface Sesion {
  steamId: string
  operador: boolean
}

export async function puertaSourcebans(
  sesion: Sesion | null,
  panelUrl: string,
  pedirEncendido: () => Promise<void>,
) {
  const h = await m.host()
  const despierta = m.despiertaDeVerdad(h)

  // Con la máquina en pie no hay nada que decidir: el panel es público.
  if (despierta) return redirigir(panelUrl)

  /* Dormida. Encender es lo único que se reserva al operador: si lo pudiera disparar
     cualquiera, bastaría con recargar esta página para tener el equipo encendido siempre. */
  if (sesion?.operador) {
    await m.marcarDespertando()
    await pedirEncendido()
    console.info(JSON.stringify({ msg: 'panel pedido con la máquina apagada; encendiendo' }))
    return html(paginaDespertando(panelUrl))
  }

  return html(paginaDormida(), 503)
}
