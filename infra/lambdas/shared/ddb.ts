/* Cliente de DynamoDB compartido.

   Se crea fuera del handler para que sobreviva entre invocaciones: reconectar en cada
   petición añadiría latencia en la ruta caliente. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

export const TABLA = process.env.table!

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})
