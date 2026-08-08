#!/usr/bin/env node
/* Entrada del despliegue.

   Dos stacks: el certificado va obligatoriamente en us-east-1 porque CloudFront lo exige,
   y todo lo demás en us-east-2. `crossRegionReferences` deja que el segundo lea el ARN del
   primero (el CDK lo resuelve con un parámetro SSM y un recurso a medida). */

import { App, Tags } from 'aws-cdk-lib'
import { loadConfig } from '../lib/config'
import { CertStack } from '../lib/cert-stack'
import { AppStack } from '../lib/app-stack'

const app = new App()
const config = loadConfig(app)

/* Etiquetas de reparto de costes. Se aplican al App entero para que las hereden los dos
   stacks y cualquier recurso que se añada despues.

   OJO: que el recurso lleve la etiqueta no basta. Hay que ACTIVAR la clave en
   Billing → Cost allocation tags; tarda ~24h en empezar a agrupar y NO es retroactiva.
   Ver el README. */
Tags.of(app).add('Project', 'l4d2-summon')
Tags.of(app).add('ManagedBy', 'cdk')
Tags.of(app).add('Owner', 'ventrax')

const cert = new CertStack(app, 'L4d2SummonCert', {
  env: { account: config.account, region: config.regionCert },
  crossRegionReferences: true,
  config,
  description: 'Certificado TLS de l4d2-summon (us-east-1, exigido por CloudFront)',
})

const aplicacion = new AppStack(app, 'L4d2Summon', {
  env: { account: config.account, region: config.regionApp },
  crossRegionReferences: true,
  config,
  certificado: cert.certificate,
  description: 'l4d2-summon: web, API, datos y encendido remoto',
})

aplicacion.addDependency(cert)
