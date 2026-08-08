/* Identidad para que la máquina de casa renueve su certificado sola.

   El panel de baneos se sirve desde casa con TLS propio, así que necesita un certificado de
   Let's Encrypt. La validación normal (HTTP-01) exige que el puerto 80 de esa máquina sea
   alcanzable desde internet, y en esta red ese puerto está asignado a otro equipo. No es un
   inconveniente que se pueda sortear: sin el 80, HTTP-01 no funciona nunca.

   La salida es validar por DNS. Certbot escribe un registro TXT en la zona y Let's Encrypt lo
   comprueba, sin tocar ningún puerto. Eso requiere credenciales de Route53 en una máquina
   doméstica, así que el permiso se recorta hasta lo mínimo: solo el registro de validación de
   ese subdominio, en esa zona, y nada más. Con esta credencial no se puede tocar ni el
   dominio de la web ni el de los servidores. */

import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'
import type { AppConfig } from '../config'

export class IdentidadCertbot extends Construct {
  public readonly usuario: iam.User

  constructor(scope: Construct, id: string, config: AppConfig) {
    super(scope, id)

    this.usuario = new iam.User(this, 'Usuario', {
      userName: 'l4d2-summon-certbot',
    })

    /* Estas dos van sobre "*" porque la API no admite recortarlas: GetChange consulta un
       identificador de cambio que no pertenece a ninguna zona, y ListHostedZones es cómo
       certbot averigua en qué zona está el dominio. Ninguna de las dos modifica nada. */
    this.usuario.addToPolicy(
      new iam.PolicyStatement({
        actions: ['route53:ListHostedZones', 'route53:GetChange'],
        resources: ['*'],
      }),
    )

    /* La que sí escribe queda atada a la zona Y al nombre exacto del registro de validación.
       Aunque la credencial se filtrara, lo único que permite es crear y borrar el TXT que
       certbot usa para demostrar que el dominio es nuestro. */
    this.usuario.addToPolicy(
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [`arn:aws:route53:::hostedzone/${config.hostedZoneId}`],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'],
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': [
              `_acme-challenge.${config.panelHostname}`,
            ],
          },
        },
      }),
    )
  }
}
