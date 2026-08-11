/* Parámetros del despliegue.

   Todo lo variable vive en el bloque `context` de cdk.json y se lee UNA vez aquí. Ningún
   construct lee context por su cuenta: reciben lo que necesitan por props. */

import type { App } from 'aws-cdk-lib'

export interface AppConfig {
  /* ¿Este despliegue es el dueño de los nombres de dominio?

     Existe porque los nombres son exclusivos: CloudFront no admite dos distribuciones con
     el mismo alias, y un registro de Route53 apunta a un sitio y solo a uno. Mientras se
     prueba la versión en la nube, esta se los cede poniéndolo en false.

     No borra nada más: la web, la API y los datos siguen aquí intactos, servidos por la
     dirección propia de CloudFront. Volver es cambiar esto a true y desplegar. */
  dominioActivo: boolean

  account: string
  regionApp: string
  regionCert: string

  /** Dominio de la plataforma web (va a CloudFront). */
  domainName: string
  hostedZoneId: string
  hostedZoneName: string

  /** Dominio de los servidores de juego. NO puede ser el mismo que el de la web: aquel
      resuelve a CloudFront, que solo habla HTTP y no enrutaría el UDP del juego. */
  gameHostname: string
  /** Dominio propio del panel de baneos, que sirve la máquina de casa con su TLS. */
  panelHostname: string
  /** Puerto del panel en casa. No es 443 porque esa red lo tiene asignado a otro equipo. */
  panelPort: number
  /** IP pública fija de la máquina anfitriona. */
  homeIp: string

  wolMac: string
  wolUdpPort: number

  /** Solo siembra el item Config la primera vez. El N vivo lo decide el operador y vive
      en DynamoDB: ninguna Lambda lee este valor para tomar decisiones. */
  serversDefault: number
  agentPollSeconds: number
  logRetentionDays: number
  budgetUsd: number
  budgetEmail: string
  priceClass: string
  ssmPrefix: string

  /** Derivados del prefijo: los nombres de los parámetros SSM. */
  ssm: {
    steamApiKey: string
    jwtSecret: string
    agentToken: string
  }
}

export function loadConfig(app: App): AppConfig {
  const raw = app.node.tryGetContext('l4d2-summon')
  if (!raw) {
    throw new Error('Falta el bloque de context "l4d2-summon" en cdk.json')
  }

  const requeridos = [
    'account', 'regionApp', 'regionCert', 'domainName', 'hostedZoneId',
    'hostedZoneName', 'gameHostname', 'panelHostname', 'homeIp', 'wolMac', 'ssmPrefix',
  ]
  for (const k of requeridos) {
    if (!raw[k]) throw new Error(`Falta el parámetro de context "${k}"`)
  }

  const prefijo: string = raw.ssmPrefix

  return {
    dominioActivo: raw.dominioActivo !== false,
    ...raw,
    ssm: {
      steamApiKey: `${prefijo}/steam-web-api-key`,
      jwtSecret: `${prefijo}/jwt-signing-secret`,
      agentToken: `${prefijo}/agent-token`,
    },
  } as AppConfig
}
