/* Aviso de gasto.

   Un presupuesto mide DÓLARES, y todo lo que cubre la capa gratuita factura cero. Se puede
   pasar del 10% al 99% del límite gratuito de Lambda sin que esto se mueva un céntimo, y
   cruzarlo de golpe un martes por la noche. Es decir: avisa cuando ya te pasaste, no cuando
   te estás acercando.

   Por eso el umbral bajo del 25%: con un gasto esperado de céntimos, llegar a 0,25 USD ya
   significa que algo cambió de orden de magnitud. */

import * as budgets from 'aws-cdk-lib/aws-budgets'
import { Construct } from 'constructs'

export class Presupuesto extends Construct {
  constructor(scope: Construct, id: string, limiteUsd: number, email: string) {
    super(scope, id)

    const avisar = (tipo: 'ACTUAL' | 'FORECASTED', umbral: number) => ({
      notification: {
        notificationType: tipo,
        comparisonOperator: 'GREATER_THAN',
        threshold: umbral,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: [{ subscriptionType: 'EMAIL', address: email }],
    })

    new budgets.CfnBudget(this, 'Presupuesto', {
      budget: {
        budgetName: 'l4d2-summon',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: limiteUsd, unit: 'USD' },
        costFilters: { TagKeyValue: ['user:Project$l4d2-summon'] },
      },
      notificationsWithSubscribers: [
        avisar('ACTUAL', 25),      // señal temprana: algo cambió de escala
        avisar('ACTUAL', 100),
        avisar('FORECASTED', 100), // necesita ~5 semanas de historial para funcionar
      ],
    })
  }
}
