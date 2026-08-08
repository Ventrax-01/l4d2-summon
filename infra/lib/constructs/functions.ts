/* Las cinco funciones del sistema.

   Ninguna va en una VPC: meterlas obligaría a un NAT Gateway (~33 USD al mes) para que la
   función de encendido pudiera alcanzar internet. Es la decisión de coste más importante de
   todo el proyecto.

   Todas llevan concurrencia reservada. No es por rendimiento: es un techo de gasto. Si
   alguien encuentra el endpoint y lo martillea, el daño queda acotado — se prefiere que
   devuelva 429 antes que una factura. */

import { Duration } from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'
import { RemovalPolicy } from 'aws-cdk-lib'
import * as path from 'node:path'
import type { AppConfig } from '../config'
import type { Secretos } from './secrets'

const LAMBDAS = path.join(__dirname, '..', '..', 'lambdas')

interface Props {
  config: AppConfig
  tabla: dynamodb.Table
  secretos: Secretos
}

export class Funciones extends Construct {
  public readonly api: NodejsFunction
  public readonly authSteam: NodejsFunction
  public readonly agente: NodejsFunction
  public readonly wol: NodejsFunction
  public readonly reaper: NodejsFunction

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id)
    const { config, tabla, secretos } = props

    const comun = {
      table: tabla.tableName,
      domain: config.domainName,
      gameHost: config.gameHostname,
      ssmSteamKey: config.ssm.steamApiKey,
      ssmJwt: config.ssm.jwtSecret,
      ssmAgentToken: config.ssm.agentToken,
      serversDefault: String(config.serversDefault),
    }

    const crear = (
      nombre: string,
      entrada: string,
      opciones: { memoria?: number; timeout?: number; concurrencia: number; env?: Record<string, string> },
    ) => {
      const grupo = new logs.LogGroup(this, `Log${nombre}`, {
        logGroupName: `/aws/lambda/l4d2-summon-${nombre}`,
        // Retención corta: el almacenamiento acumulado es el coste oculto clásico de Logs.
        retention: config.logRetentionDays as logs.RetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      })

      return new NodejsFunction(this, nombre, {
        functionName: `l4d2-summon-${nombre}`,
        entry: path.join(LAMBDAS, entrada),
        runtime: lambda.Runtime.NODEJS_22_X,
        // arm64: ~20% más barato y algo más rápido que x86.
        architecture: lambda.Architecture.ARM_64,
        memorySize: opciones.memoria ?? 256,
        timeout: Duration.seconds(opciones.timeout ?? 10),
        reservedConcurrentExecutions: opciones.concurrencia,
        logGroup: grupo,
        loggingFormat: lambda.LoggingFormat.JSON,
        // Sin los START/END/REPORT de cada invocación: con el agente consultando cada 15s
        // son cientos de miles de líneas al mes que no aportan nada.
        systemLogLevelV2: lambda.SystemLogLevel.WARN,
        applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        environment: { ...comun, ...(opciones.env ?? {}) },
        bundling: {
          minify: true,
          sourceMap: false,
          target: 'node22',
          // El SDK v3 ya viene en el runtime: no hace falta empaquetarlo.
          externalModules: ['@aws-sdk/*'],
        },
      })
    }

    // --- API pública: la usa el navegador a través de CloudFront ---
    this.api = crear('api', 'api/index.ts', { memoria: 512, timeout: 10, concurrencia: 10 })
    tabla.grantReadWriteData(this.api)
    secretos.permitirLeer(this.api, config.ssm.jwtSecret)

    // --- Login con Steam ---
    this.authSteam = crear('auth-steam', 'auth-steam/index.ts', {
      memoria: 512, timeout: 10, concurrencia: 5,
    })
    tabla.grantReadWriteData(this.authSteam)
    secretos.permitirLeer(this.authSteam, config.ssm.jwtSecret, config.ssm.steamApiKey)

    // --- Endpoint del agente: la ruta más caliente, por eso va ajustada ---
    this.agente = crear('agent', 'agent/index.ts', { memoria: 256, timeout: 5, concurrencia: 2 })
    tabla.grantReadWriteData(this.agente)
    secretos.permitirLeer(this.agente, config.ssm.agentToken)

    // --- Encendido remoto: manda el paquete UDP a la IP fija de casa ---
    this.wol = crear('wol', 'wol/index.ts', {
      memoria: 128, timeout: 15, concurrencia: 1,
      env: { wolMac: config.wolMac, wolIp: config.homeIp, wolPort: String(config.wolUdpPort) },
    })
    tabla.grantReadWriteData(this.wol)

    // --- Barrido periódico ---
    this.reaper = crear('reaper', 'reaper/index.ts', { memoria: 256, timeout: 60, concurrencia: 1 })
    tabla.grantReadWriteData(this.reaper)

    // La API y el barrido pueden pedir un encendido.
    for (const fn of [this.api, this.reaper]) {
      this.wol.grantInvoke(fn)
      fn.addEnvironment('wolFunction', this.wol.functionName)
    }

    // Nadie más puede invocar estas funciones directamente.
    for (const fn of [this.api, this.authSteam, this.agente]) {
      fn.addPermission?.bind(fn)
    }
  }

  /** Function URLs protegidas: solo CloudFront puede invocarlas, vía OAC. */
  public urlPrivada(fn: NodejsFunction): lambda.FunctionUrl {
    return fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.BUFFERED,
    })
  }
}

export type { NodejsFunction, iam }
