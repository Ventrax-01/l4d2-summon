/* El stack principal: cablea todos los constructs.

   Es el único sitio donde las piezas se conocen entre sí; cada construct por separado
   recibe lo que necesita por props y no lee configuración por su cuenta. */

import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import type { Construct } from 'constructs'
import type { AppConfig } from './config'
import { Datos } from './constructs/data'
import { Secretos } from './constructs/secrets'
import { Funciones } from './constructs/functions'
import { SitioEstatico } from './constructs/static-site'
import { CabecerasSeguridad } from './constructs/response-headers'
import { Cdn } from './constructs/cdn'
import { Horarios } from './constructs/scheduling'
import { Dns } from './constructs/dns'
import { Presupuesto } from './constructs/budget'

interface Props extends StackProps {
  config: AppConfig
  certificado: acm.ICertificate
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props)
    const { config, certificado } = props

    /* Secreto que prueba que una petición viene de CloudFront. Es de tipo String y no
       SecureString porque CloudFormation tiene que leerlo en despliegue para ponerlo como
       cabecera del origen; solo sirve a quien además conozca la URL de la función. */
    const secretoOrigen = ssm.StringParameter.valueForStringParameter(
      this, `${config.ssmPrefix}/origin-secret`,
    )

    const datos = new Datos(this, 'Datos')
    const secretos = new Secretos(this, 'Secretos', config)

    const funciones = new Funciones(this, 'Funciones', {
      config,
      tabla: datos.tabla,
      secretos,
      secretoOrigen,
    })

    const sitio = new SitioEstatico(this, 'Sitio', config.account)
    const cabeceras = new CabecerasSeguridad(this, 'Cabeceras')

    const cdn = new Cdn(this, 'Cdn', {
      config,
      certificado,
      bucket: sitio.bucket,
      urlApi: funciones.urlPublica(funciones.api),
      urlAuth: funciones.urlPublica(funciones.authSteam),
      urlAgente: funciones.urlPublica(funciones.agente),
      cabeceras: cabeceras.politica,
      secretoOrigen,
    })

    new Horarios(this, 'Horarios', funciones.reaper)
    new Dns(this, 'Dns', config, cdn.distribucion)
    new Presupuesto(this, 'Presupuesto', config.budgetUsd, config.budgetEmail)

    // Lo que hace falta para desplegar la web y para configurar el agente.
    new CfnOutput(this, 'SitioUrl', { value: `https://${config.domainName}` })
    new CfnOutput(this, 'BucketWeb', { value: sitio.bucket.bucketName })
    new CfnOutput(this, 'DistributionId', { value: cdn.distribucion.distributionId })
    new CfnOutput(this, 'TablaDatos', { value: datos.tabla.tableName })
    new CfnOutput(this, 'EndpointAgente', {
      value: `https://${config.domainName}/agent`,
      description: 'A donde apunta el agente de la maquina anfitriona',
    })
    new CfnOutput(this, 'HostDeJuego', {
      value: `${config.gameHostname} → ${config.homeIp}`,
      description: 'Los servidores de juego NO van por CloudFront',
    })
  }
}
