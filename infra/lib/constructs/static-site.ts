/* Bucket del sitio: privado, solo accesible desde CloudFront.

   Las miniaturas de mapa viven dentro del propio bundle del front (web/public/mapas), así
   que un solo bucket sirve para todo. Como están versionadas en git, un despliegue que las
   borrara las repondría: no hay dato que perder aquí. */

import { RemovalPolicy, Duration } from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'

export class SitioEstatico extends Construct {
  public readonly bucket: s3.Bucket

  constructor(scope: Construct, id: string, cuenta: string) {
    super(scope, id)

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `l4d2-summon-web-${cuenta}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // Cifrado gestionado por S3: gratis. Con KMS habría coste por petición.
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Sin versionado: el sitio se reconstruye desde el repo, y las versiones antiguas
      // solo acumularían almacenamiento.
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
    })
  }
}
