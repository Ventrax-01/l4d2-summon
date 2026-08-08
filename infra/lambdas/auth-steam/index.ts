/* Login con Steam (OpenID 2.0).

   Steam no da OAuth; usa OpenID 2.0, que funciona así: se manda al usuario a Steam con unos
   parámetros, Steam le pide su contraseña y lo devuelve aquí con una firma. Esa firma NO se
   valida por cuenta propia: se le reenvía a Steam preguntándole "¿esto lo firmaste tú?".

   Es el paso que hace que la identidad sea de fiar. Sin él, cualquiera podría llegar al
   retorno con el SteamID de otro en la URL y quedarse con su cuenta. */

import { error, redirigir } from '../shared/http'
import { vieneDeCloudFront } from '../shared/origen'
import { secreto } from '../shared/ssm'
import { emitir, cookieSesion, cookieBorrado } from '../shared/jwt'
import { registrarEntrada } from '../shared/usuarios'

const DOMINIO = process.env.domain!
const SSM_JWT = process.env.ssmJwt!
const SSM_STEAM = process.env.ssmSteamKey!

const STEAM_OPENID = 'https://steamcommunity.com/openid/login'
const SITIO = `https://${DOMINIO}`
const RETORNO = `${SITIO}/auth/steam/return`

interface Evento {
  rawPath?: string
  rawQueryString?: string
  headers?: Record<string, string | undefined>
  requestContext?: { http?: { method?: string; path?: string } }
}

// ---------------------------------------------------------------- inicio

function iniciar() {
  const p = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': RETORNO,
    'openid.realm': SITIO,
    // Estos dos valores fijos significan "identifica al usuario, tú eliges cómo".
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  })
  return redirigir(`${STEAM_OPENID}?${p}`)
}

// ---------------------------------------------------------------- retorno

/** Le devuelve a Steam sus propios parámetros preguntándole si la firma es suya. */
async function steamConfirmaLaFirma(query: URLSearchParams): Promise<boolean> {
  const cuerpo = new URLSearchParams(query)
  cuerpo.set('openid.mode', 'check_authentication')

  const r = await fetch(STEAM_OPENID, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: cuerpo.toString(),
  })
  const texto = await r.text()
  return /is_valid\s*:\s*true/.test(texto)
}

/** El claimed_id llega como https://steamcommunity.com/openid/id/7656119... */
function steamIdDe(claimedId: string | null): string | null {
  if (!claimedId) return null
  const m = claimedId.match(/\/openid\/id\/(\d{17})$/)
  return m ? m[1] : null
}

/** Nick y avatar. Si falla, el login sigue adelante: son un adorno, no la identidad. */
async function perfilDeSteam(steamId: string): Promise<{ nick: string; avatar?: string }> {
  try {
    const clave = await secreto(SSM_STEAM)
    const u = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/')
    u.searchParams.set('key', clave)
    u.searchParams.set('steamids', steamId)

    const r = await fetch(u, { signal: AbortSignal.timeout(4000) })
    const j = (await r.json()) as {
      response?: { players?: { personaname?: string; avatarfull?: string }[] }
    }
    const p = j.response?.players?.[0]
    if (p?.personaname) return { nick: p.personaname, avatar: p.avatarfull }
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'no se pudo leer el perfil de Steam', steamId, e: String(e) }))
  }
  // Sin nick real se usa algo reconocible en vez de dejarlo vacío.
  return { nick: `Jugador ${steamId.slice(-4)}` }
}

async function retornar(rawQuery: string) {
  const query = new URLSearchParams(rawQuery)

  if (query.get('openid.mode') === 'cancel') {
    return redirigir(`${SITIO}/entrar?error=cancelado`)
  }

  if (!(await steamConfirmaLaFirma(query))) {
    console.warn(JSON.stringify({ msg: 'Steam no reconoce la firma del retorno' }))
    return redirigir(`${SITIO}/entrar?error=firma`)
  }

  const steamId = steamIdDe(query.get('openid.claimed_id'))
  if (!steamId) return redirigir(`${SITIO}/entrar?error=identidad`)

  const perfil = await perfilDeSteam(steamId)
  const usuario = await registrarEntrada({ steamId, ...perfil })

  if (usuario.suspendido) {
    return redirigir(`${SITIO}/entrar?error=suspendido`)
  }

  const token = emitir(
    {
      steamId,
      nick: usuario.nick,
      avatar: usuario.avatar ?? undefined,
      operador: usuario.operador,
    },
    await secreto(SSM_JWT),
  )

  return redirigir(SITIO, { 'set-cookie': cookieSesion(token) })
}

// ---------------------------------------------------------------- entrada

export async function handler(evento: Evento) {
  if (!vieneDeCloudFront(evento.headers ?? {})) {
    return error('UNAUTHORIZED', 'Acceso no autorizado.')
  }

  const ruta = evento.requestContext?.http?.path ?? evento.rawPath ?? ''

  if (ruta.endsWith('/auth/steam/login')) return iniciar()
  if (ruta.endsWith('/auth/steam/return')) return retornar(evento.rawQueryString ?? '')
  if (ruta.endsWith('/auth/logout')) {
    return redirigir(SITIO, { 'set-cookie': cookieBorrado() })
  }

  return error('NOT_FOUND', 'Ruta de autenticación desconocida.')
}
