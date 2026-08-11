/* DNS. Dos nombres con destinos muy distintos:

   · l4d2.ventrax.dev  → CloudFront. Es la web.
   · play.ventrax.dev  → la IP fija de casa. Son los servidores de juego.

   Tienen que ser nombres separados: el del sitio resuelve a CloudFront, que solo habla
   HTTP y no enrutaría el UDP del juego. Un `connect l4d2.ventrax.dev:6033` no llegaría
   a ninguna parte. */

import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import { Duration } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import type { AppConfig } from '../config'

export class Dns extends Construct {
  constructor(scope: Construct, id: string, config: AppConfig, distribucion: cloudfront.Distribution) {
    super(scope, id)

    const zona = route53.HostedZone.fromHostedZoneAttributes(this, 'Zona', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    })

    /* Cedidos a otro despliegue: aquí no se declara ningún registro.

       Los nombres son exclusivos —un registro apunta a un sitio y solo a uno—, así que
       mientras la versión en la nube los use, esta no puede declararlos sin pisárselos.
       Volver a tenerlos es poner `dominioActivo` en true y desplegar. */
    if (!config.dominioActivo) return

    // La web. Los alias hacia recursos de AWS no cuentan como consultas facturables.
    const alias = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribucion))
    new route53.ARecord(this, 'SitioA', {
      zone: zona,
      recordName: config.domainName,
      target: alias,
    })
    new route53.AaaaRecord(this, 'SitioAAAA', {
      zone: zona,
      recordName: config.domainName,
      target: alias,
    })

    /* El panel de baneos tiene su propio nombre apuntando a casa, no a CloudFront: el
       navegador habla TLS directamente con la máquina. Ver lambdas/api/sourcebans.ts. */
    new route53.ARecord(this, 'PanelA', {
      zone: zona,
      recordName: config.panelHostname,
      target: route53.RecordTarget.fromIpAddresses(config.homeIp),
      ttl: Duration.minutes(5),
    })

    // Los servidores de juego, directo a casa.
    new route53.ARecord(this, 'JuegoA', {
      zone: zona,
      recordName: config.gameHostname,
      target: route53.RecordTarget.fromIpAddresses(config.homeIp),
      // TTL corto por si algún día la IP deja de ser fija: cambiarla se propaga rápido.
      ttl: Duration.minutes(5),
    })
  }
}
