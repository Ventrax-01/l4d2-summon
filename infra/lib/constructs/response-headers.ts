/* Cabeceras de seguridad de las respuestas.

   La política de contenido es estricta a propósito: la aplicación no carga scripts de
   terceros. Las excepciones son las fuentes de Google (que usa el diseño) y los enlaces
   steam:// que abren el juego. */

import { Duration } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import { Construct } from 'constructs'

export class CabecerasSeguridad extends Construct {
  public readonly politica: cloudfront.ResponseHeadersPolicy

  constructor(scope: Construct, id: string) {
    super(scope, id)

    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      // Las variables CSS y los estilos en línea del diseño necesitan unsafe-inline.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      // data: para los avatares generados; https: para los de Steam.
      "img-src 'self' data: https://avatars.steamstatic.com",
      "connect-src 'self'",
      "form-action 'self' https://steamcommunity.com",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ')

    this.politica = new cloudfront.ResponseHeadersPolicy(this, 'Politica', {
      responseHeadersPolicyName: 'l4d2-summon-seguridad',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: false,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
      },
      removeHeaders: ['server'],
    })
  }
}
