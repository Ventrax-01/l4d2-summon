/* Tabla única de DynamoDB.

   Modo PROVISIONED a propósito: la capa gratuita permanente de DynamoDB son 25 RCU + 25 WCU
   y aplica EXCLUSIVAMENTE a tablas provisionadas. On-demand se cobra desde la primera
   petición, así que rompería el objetivo de coste.

   Sin auto-escalado, también a propósito: escalar por encima de 25 empezaría a facturar sin
   avisar. Si algún día hay throttling, se sube el número a mano tras verlo.

   El presupuesto de 25/25 es POR CUENTA Y REGIÓN, y los índices consumen aparte: por eso
   la tabla usa 20/20 y el índice 5/5, y no cabe un segundo índice sin recalcular. */

import { RemovalPolicy } from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'

export class Datos extends Construct {
  public readonly tabla: dynamodb.Table

  constructor(scope: Construct, id: string) {
    super(scope, id)

    this.tabla = new dynamodb.Table(this, 'Tabla', {
      tableName: 'l4d2-summon',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 20,
      writeCapacity: 20,
      // Expira reservas y turnos vencidos sin consumir capacidad de escritura.
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      // Los datos (usuarios, historial) no son reconstruibles: no se borran con el stack.
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    })

    // Único índice: lo usa el barrido periódico para encontrar las reservas cuyo plazo venció,
    // sin recorrer la tabla entera. Solo lleva las no terminadas, así se mantiene diminuto.
    this.tabla.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      readCapacity: 5,
      writeCapacity: 5,
    })
  }
}
