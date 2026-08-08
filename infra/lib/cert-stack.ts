/* Certificado TLS del sitio.

   Vive en un stack aparte porque CloudFront EXIGE que su certificado esté en us-east-1,
   mientras que el resto de la infraestructura está en us-east-2. Es el único motivo de que
   haya dos stacks.

   La validación es automática: la zona de ventrax.dev está en Route53, en esta misma cuenta,
   así que el CDK crea el registro CNAME de validación solo. */

import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import type { Construct } from 'constructs'
import type { AppConfig } from './config'

interface Props extends StackProps {
  config: AppConfig
}

export class CertStack extends Stack {
  public readonly certificate: acm.ICertificate

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props)
    const { config } = props

    const zona = route53.HostedZone.fromHostedZoneAttributes(this, 'Zona', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    })

    this.certificate = new acm.Certificate(this, 'Cert', {
      certificateName: 'l4d2-summon',
      domainName: config.domainName,
      validation: acm.CertificateValidation.fromDns(zona),
    })

    new CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn })
  }
}
