/* Secretos: SSM Parameter Store, no Secrets Manager.

   Secrets Manager cobra 0,40 USD por secreto y mes; con tres secretos serían 1,20 al mes,
   más que todo el resto del sistema junto. Parameter Store en su nivel estándar es gratis.

   Los parámetros NO se crean aquí: un SecureString no se puede crear desde CloudFormation.
   Se crean a mano una vez (ver el README) y este construct solo los referencia y concede
   permisos de lectura. */

import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Stack } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import type { AppConfig } from '../config'

export class Secretos extends Construct {
  private readonly nombres: string[]

  constructor(scope: Construct, id: string, private readonly config: AppConfig) {
    super(scope, id)
    this.nombres = [config.ssm.steamApiKey, config.ssm.jwtSecret, config.ssm.agentToken]
  }

  /** Permite a una función leer los parámetros indicados (por su nombre completo). */
  public permitirLeer(rol: iam.IGrantable, ...nombres: string[]): void {
    const stack = Stack.of(this)
    const arns = (nombres.length ? nombres : this.nombres).map(
      (n) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${n}`,
    )

    rol.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: arns,
      }),
    )

    // Los SecureString se cifran con la clave gestionada por AWS para SSM; hace falta
    // permiso explícito para descifrarlos.
    rol.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [`arn:aws:kms:${stack.region}:${stack.account}:alias/aws/ssm`],
      }),
    )
  }

  /** Nombres para inyectarlos como variables de entorno (el valor se lee en caliente). */
  public get refs() {
    return this.config.ssm
  }

  /** Comprobación en tiempo de síntesis de que los parámetros existen. */
  public verificarExisten(): void {
    for (const [i, nombre] of this.nombres.entries()) {
      ssm.StringParameter.fromStringParameterName(this, `Chequeo${i}`, nombre)
    }
  }
}
