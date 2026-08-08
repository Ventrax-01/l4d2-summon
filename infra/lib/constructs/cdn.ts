/* CloudFront: la única puerta de entrada.

   Todo cuelga del mismo dominio, así que el navegador nunca hace peticiones a otro origen y
   NO hay CORS que configurar. Además las Function URLs quedan privadas: solo CloudFront
   puede invocarlas.

   Dos trampas que este archivo resuelve y conviene conocer:

   1. El fallback de la SPA usa el error 403, no solo el 404. Con OAC y sin permiso de
      listado, S3 responde 403 (no 404) ante una ruta que no existe, como /perfil.

   2. Los `errorResponses` son de la distribución ENTERA, así que también afectarían a las
      respuestas de la API: un 404 del backend se convertiría en index.html con estado 200.
      Por eso se limitan a los códigos que la API tiene prohibido devolver (ver el contrato
      en docs/tecnico/02-estados-api.md: usa 401/409/422 en su lugar). */

import { Duration } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type * as lambda from 'aws-cdk-lib/aws-lambda'
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
}

export class Cdn extends Construct {
  public readonly distribucion: cloudfront.Distribution

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id)
    const { config, certificado, bucket, cabeceras } = props

    /* CloudFront firma la petición hacia la Lambda, pero NO firma el cuerpo, así que
       cualquier POST fallaría la validación. Marcarlo como carga no firmada es la solución
       documentada por AWS. */
    const sinFirmarCuerpo = new cloudfront.Function(this, 'CuerpoSinFirmar', {
      functionName: 'l4d2-summon-unsigned-payload',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  event.request.headers['x-amz-content-sha256'] = { value: 'UNSIGNED-PAYLOAD' };
  return event.request;
}`),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    })

    const comportamientoLambda = (url: lambda.FunctionUrl): cloudfront.BehaviorOptions => ({
      origin: origins.FunctionUrlOrigin.withOriginAccessControl(url),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      /* El Host debe seguir siendo el de la Function URL para que la firma valide, pero el
         resto de cabeceras (incluida Authorization) sí se reenvían. */
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: cabeceras,
      compress: true,
      functionAssociations: [
        { function: sinFirmarCuerpo, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
      ],
    })

    this.distribucion = new cloudfront.Distribution(this, 'Distribucion', {
      comment: 'l4d2-summon',
      domainNames: [config.domainName],
      certificate: certificado,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      // Los registros de acceso a S3 son un coste oculto y aquí no aportan nada.
      enableLogging: false,

      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cabeceras,
        compress: true,
      },

      additionalBehaviors: {
        '/api/*': comportamientoLambda(props.urlApi),
        '/auth/*': comportamientoLambda(props.urlAuth),
        '/agent/*': comportamientoLambda(props.urlAgente),
      },

      /* Rutas de la SPA: /perfil no es un objeto de S3, así que devuelve 403 (por OAC) o
         404. Se sirve index.html y el enrutador del navegador se encarga. Sin caché, para
         que un despliegue nuevo se vea al momento. */
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
      ],
    })
  }
}
