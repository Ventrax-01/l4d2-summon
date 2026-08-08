/* La puerta al panel de baneos.

   El panel no es parte de la plataforma: es una aplicación de administración que corre en la
   máquina de casa y que solo tiene sentido para quien gestiona la flota. Esta ruta hace tres
   cosas y ninguna más:

     1. Comprueba que quien llama es operador.
     2. Enciende la máquina si está apagada, porque el panel no responde con ella dormida.
     3. Lleva al panel cuando está listo.

   Lo que NO hace es servir el panel a través de CloudFront. Ese salto iría por internet
   entre el borde y la casa, y ahí viajan la contraseña del panel y su cookie de sesión. Se
   prefiere mandar al navegador directamente contra la máquina, que habla TLS de extremo a
   extremo con su propio certificado. La consecuencia es que la barra de direcciones cambia
   de dominio al entrar; a cambio, nadie intermedia credenciales de administración. */

import { redirigir } from '../shared/http'
import * as m from '../shared/modelo'

/** Página mínima e independiente: se sirve mientras la máquina arranca y se recarga sola.
    No usa nada de la SPA a propósito — tiene que funcionar aunque el resto falle. */
function paginaDespertando(destino: string): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Encendiendo el servidor…</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#101114; color:#f2f4f8;
         font-family:ui-sans-serif,system-ui,sans-serif; text-align:center; padding:24px; }
  .c { max-width:32rem; display:flex; flex-direction:column; gap:14px; }
  h1 { font-size:1.4rem; margin:0; font-weight:650; }
  p { margin:0; color:#9aa3b2; line-height:1.6; }
  .b { height:4px; border-radius:99px; background:#1b1f27; overflow:hidden; }
  .b > i { display:block; height:100%; width:35%; border-radius:99px; background:#28d8ff;
           animation:v 1.4s ease-in-out infinite; }
  @keyframes v { 0%{transform:translateX(-100%)} 100%{transform:translateX(320%)} }
  @media (prefers-reduced-motion:reduce){ .b > i { animation:none; width:100% } }
</style></head>
<body><div class="c">
  <h1>Encendiendo el servidor</h1>
  <p>El panel de baneos vive en la máquina de casa, que estaba apagada.
     Suele tardar menos de un minuto.</p>
  <div class="b"><i></i></div>
  <p><small>Esta página se abre sola cuando esté lista.</small></p>
</div>
<script>
  // Se pregunta al mismo estado que usa la web; en cuanto la máquina reporta, se entra.
  var destino = ${JSON.stringify(destino)};
  setInterval(function () {
    fetch('/api/state', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (d) { if (d.host && d.host.state === 'UP') location.href = destino })
      .catch(function () {});
  }, 4000);
</script></body></html>`
}

function html(cuerpo: string, estado = 200) {
  return {
    statusCode: estado,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: cuerpo,
  }
}

const NO_ERES_OPERADOR = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Sin acceso</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101114;
color:#f2f4f8;font-family:ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px}
p{color:#9aa3b2;max-width:34rem;line-height:1.6}</style></head>
<body><div><h1>Esto es del operador</h1>
<p>El panel de baneos lo lleva quien administra la flota. Si crees que deberías tener acceso,
habla con quien gestiona los servidores.</p></div></body></html>`

interface Sesion {
  steamId: string
  operador: boolean
}

/** Devuelve la respuesta para /sourcebans, o null si la ruta no es esta. */
export async function puertaSourcebans(
  sesion: Sesion | null,
  panelUrl: string,
  sitio: string,
  pedirEncendido: () => Promise<void>,
) {
  // Sin sesión no se revela siquiera que esto existe: se manda a entrar y se vuelve aquí.
  if (!sesion) {
    return redirigir(`${sitio}/entrar?volver=${encodeURIComponent('/sourcebans')}`)
  }

  if (!sesion.operador) {
    console.warn(JSON.stringify({ msg: 'acceso al panel denegado', steamId: sesion.steamId }))
    return html(NO_ERES_OPERADOR, 403)
  }

  const h = await m.host()
  if (m.despiertaDeVerdad(h)) return redirigir(panelUrl)

  /* Encender es exactamente lo que hace el sistema al reservar, así que se reutiliza el
     mismo camino. La página de espera se encarga de entrar cuando la máquina reporte. */
  await m.marcarDespertando()
  await pedirEncendido()
  console.info(JSON.stringify({ msg: 'panel pedido con la máquina apagada; encendiendo' }))
  return html(paginaDespertando(panelUrl))
}
