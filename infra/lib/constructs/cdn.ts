/* CloudFront: la única puerta de entrada.

   Todo cuelga del mismo dominio, así que el navegador nunca hace peticiones a otro origen y
   NO hay CORS que configurar.

   Dos decisiones que costaron encontrar y conviene no deshacer sin leer esto:

   1. El enrutado de la SPA NO usa `errorResponses`. Esa opción es de la distribución ENTERA,
      así que se traga también los errores de la API: un 403 del origen Lambda se convertía
      en index.html con estado 200 y el fallo real quedaba invisible. Se resuelve
      reescribiendo la ruta ANTES de ir a S3, y solo en el comportamiento por defecto.

   2. Las Function URLs NO usan OAC (control de acceso al origen). Se intentó —es lo más
      elegante, deja la URL privada— pero la firma SigV4 hacia Lambda devolvía 403 de forma
      persistente aun con la configuración que indica la documentación: tipo `lambda`, firma
      `always`, y política de invocación con el ARN de la distribución. Se descartaron por
      separado la función de carga-no-firmada y la política de reenvío de cabeceras, y
      ninguna era la causa.

      En su lugar se usa el patrón anterior a OAC: la URL queda abierta pero CloudFront añade
      una cabecera con un secreto compartido, y la función rechaza lo que no la traiga. El
      nombre de la Function URL ya es aleatorio de 32 caracteres, así que el secreto es una
      segunda barrera, no la única. Si OAC hacia Lambda llega a funcionar, merece volver. */

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type * as lambda from 'aws-cdk-lib/aws-lambda'
import { Fn } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import type { AppConfig } from '../config'

interface Props {
  config: AppConfig
  certificado: acm.ICertificate
  bucket: s3.Bucket
  urlApi: lambda.FunctionUrl
  urlAuth: lambda.FunctionUrl
  urlAgente: lambda.FunctionUrl
  cabeceras: cloudfront.ResponseHeadersPolicy
  /** Secreto que CloudFront envía a las funciones para probar que la petición viene de él. */
  secretoOrigen: string
}

export class Cdn extends Construct {
  public readonly distribucion: cloudfront.Distribution

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id)
    const { config, certificado, bucket, cabeceras, secretoOrigen } = props

    /* Enrutado de la SPA: /perfil no es un objeto de S3. En vez de dejar que falle y mapear
       el error, se reescribe la ruta a /index.html antes de consultar S3. Solo se aplica al
       comportamiento por defecto, así que las rutas de API quedan intactas. */
    const rutasSpa = new cloudfront.Function(this, 'RutasSpa', {
      functionName: 'l4d2-summon-spa-routing',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var uri = event.request.uri;
  // Sin punto = ruta de la aplicación, no un archivo.
  if (uri.indexOf('.') === -1) { event.request.uri = '/index.html'; }
  return event.request;
}`),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    })

    /** La URL de la función viene como https://xxx.lambda-url.../ ; el origen necesita solo
        el nombre de host. */
    const host = (url: lambda.FunctionUrl) => Fn.select(2, Fn.split('/', url.url))

    const comportamientoLambda = (url: lambda.FunctionUrl): cloudfront.BehaviorOptions => ({
      origin: new origins.HttpOrigin(host(url), {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        customHeaders: { 'x-origen-secreto': secretoOrigen },
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // El Host debe ser el de la Function URL; el resto de cabeceras y la cadena de consulta
      // sí se reenvían, que las necesita el retorno de Steam.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: cabeceras,
      compress: true,
    })

    this.distribucion = new cloudfront.Distribution(this, 'Distribucion', {
      comment: 'l4d2-summon',
      domainNames: [config.domainName],
      certificate: certificado,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      // Los registros de acceso son un coste oculto y aquí no aportan nada.
      enableLogging: false,

      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cabeceras,
        compress: true,
        functionAssociations: [
          { function: rutasSpa, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },

      additionalBehaviors: {
        '/api/*': comportamientoLambda(props.urlApi),
        '/auth/*': comportamientoLambda(props.urlAuth),
        '/agent/*': comportamientoLambda(props.urlAgente),
        /* La puerta al panel: la Lambda comprueba si hay que encender la máquina y manda
           a /sourcebans/. Ver lambdas/api/sourcebans.ts. */
        '/sourcebans': comportamientoLambda(props.urlApi),

        /* Y el panel en sí, servido desde casa a través del CDN.

           Va por HTTPS contra un certificado propio de la máquina: ese salto cruza internet
           y por él viajan contraseñas de administración. El puerto no es el 443 porque en
           esa red está asignado a otro equipo — da igual, nadie lo escribe nunca.

           Sin caché: el panel tiene sesiones y formularios. Lo que se ahorra el CDN aquí no
           compensa servir a alguien la sesión de otro. */
        '/sourcebans/*': {
          origin: new origins.HttpOrigin(config.panelHostname, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            httpsPort: config.panelPort,
            customHeaders: { 'x-origen-secreto': secretoOrigen },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
    })
  }
}
