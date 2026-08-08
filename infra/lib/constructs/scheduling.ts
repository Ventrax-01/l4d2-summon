/* Un único disparo periódico para todo lo temporal.

   Cada minuto se invoca el barrido, que hace tres cosas: caducar reservas que se quedaron
   colgadas, expirar turnos de cola que nadie reclamó, y reintentar el encendido si la
   máquina no ha dado señales.

   Un minuto basta: los plazos del sistema son de decenas de segundos a minutos. Y es el
   mínimo que permite un horario recurrente, así que tampoco hay opción de bajar más. */

import * as scheduler from 'aws-cdk-lib/aws-scheduler'
import * as iam from 'aws-cdk-lib/aws-iam'
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { Construct } from 'constructs'

export class Horarios extends Construct {
  constructor(scope: Construct, id: string, reaper: NodejsFunction) {
    super(scope, id)

    const grupo = new scheduler.CfnScheduleGroup(this, 'Grupo', {
      name: 'l4d2-summon',
    })

    const rol = new iam.Role(this, 'RolInvocacion', {
      roleName: 'l4d2-summon-scheduler',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    })
    reaper.grantInvoke(rol)

    new scheduler.CfnSchedule(this, 'Tick', {
      name: 'l4d2-summon-tick',
      groupName: grupo.name,
      scheduleExpression: 'rate(1 minute)',
      // Sin ventana flexible: interesa que corra puntual, no repartido.
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: reaper.functionArn,
        roleArn: rol.roleArn,
        retryPolicy: { maximumRetryAttempts: 1 },
      },
    })

    this.node.addDependency(grupo)
  }
}
