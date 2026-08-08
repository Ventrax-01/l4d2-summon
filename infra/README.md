# Infraestructura (AWS CDK)

Define en código toda la parte de nube: el sitio, la API, los datos y el encendido remoto.
Dos stacks, porque CloudFront **exige** que su certificado esté en `us-east-1` mientras el
resto vive en `us-east-2`.

| Stack | Región | Qué tiene |
|---|---|---|
| `L4d2SummonCert` | us-east-1 | Solo el certificado TLS |
| `L4d2Summon` | us-east-2 | S3, CloudFront, DynamoDB, las Lambdas, el disparo periódico, DNS y el presupuesto |

## Desplegar

```bash
aws sso login --profile ventrax_infra_prod
export AWS_PROFILE=ventrax_infra_prod

cd infra
npm install
npx cdk diff            # SIEMPRE antes de desplegar
npx cdk deploy --all
```

Requiere el bootstrap del CDK en **las dos** regiones (us-east-2 ya lo está):

```bash
npx cdk bootstrap aws://211125402452/us-east-1
```

## Antes del primer despliegue: los secretos

CloudFormation no puede crear parámetros cifrados, así que estos tres se crean **a mano una
vez**. El código solo los referencia y concede permiso de lectura.

```bash
# Clave de la Steam Web API (para leer nick y avatar) — https://steamcommunity.com/dev/apikey
aws ssm put-parameter --name /l4d2-summon/steam-web-api-key \
  --type SecureString --value "TU_CLAVE"

# Secreto con el que se firman las sesiones
aws ssm put-parameter --name /l4d2-summon/jwt-signing-secret \
  --type SecureString --value "$(openssl rand -hex 32)"

# Token del agente de la máquina anfitriona (el mismo valor va en /etc/l4d2-summon/agent.token)
aws ssm put-parameter --name /l4d2-summon/agent-token \
  --type SecureString --value "$(openssl rand -hex 32)"
```

## Desplegar la web

El bucket es privado y solo CloudFront lo lee. El **orden importa**: si `index.html` sube
antes que los recursos, hay unos segundos en los que el HTML nuevo pide archivos que aún no
existen y la página sale en blanco.

```bash
npm --prefix ../web run build

# 1. Primero los recursos: llevan hash en el nombre, así que son inmutables
aws s3 sync ../web/dist s3://l4d2-summon-web-211125402452 --delete \
  --exclude index.html --cache-control "public,max-age=31536000,immutable"

# 2. Después el HTML, que es el único archivo que cambia de contenido sin cambiar de nombre
aws s3 cp ../web/dist/index.html s3://l4d2-summon-web-211125402452/index.html \
  --cache-control "no-cache,must-revalidate"

# 3. Y solo entonces se invalida
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths /index.html /
```

## Ver los costes de este proyecto

Todos los recursos llevan las etiquetas `Project=l4d2-summon`, `ManagedBy=cdk` y
`Owner=ventrax`.

**La etiqueta por sí sola no agrupa nada.** Hay que activarla una vez:

Billing → **Cost allocation tags** → activar la clave `Project`.

Tarda unas 24 horas en empezar a aplicarse y **no es retroactiva**: lo facturado antes de
activarla no se puede agrupar. Conviene hacerlo el mismo día del primer despliegue.

Después, en Cost Explorer se puede filtrar por `Project = l4d2-summon` y ver solo lo que
cuesta esto, separado del resto de la cuenta.

El presupuesto de aviso que crea el stack **ya filtra por esa etiqueta**, así que no saltará
por gastos ajenos al proyecto.

## Decisiones que conviene conocer

**DynamoDB en modo provisionado, no bajo demanda.** La capa gratuita permanente son 25 RCU y
25 WCU, y aplica *solo* a tablas provisionadas; bajo demanda se cobra desde la primera
petición. El reparto es 20/20 la tabla y 5/5 el índice: exactamente el límite. **Un segundo
índice no cabe** sin recalcular. El auto-escalado está desactivado a propósito, porque
escalar por encima de 25 empezaría a facturar sin avisar.

**Ninguna Lambda va en una VPC.** Meterlas obligaría a un NAT Gateway (~33 USD al mes) solo
para que la función de encendido alcanzara internet. Es la decisión de coste más importante
del proyecto.

**Todas llevan concurrencia reservada**, como techo de gasto y no por rendimiento: si alguien
descubre el endpoint y lo martillea, se prefiere devolver 429 antes que recibir una factura.

**Las Function URLs son privadas** (`AWS_IAM`) y solo CloudFront puede invocarlas. Como todo
cuelga del mismo dominio, tampoco hay CORS que configurar.

**Los secretos van en Parameter Store, no en Secrets Manager**, que cobra 0,40 USD por secreto
y mes: los tres costarían más que todo el resto del sistema junto.

**El backend nunca devuelve 403 ni 404.** CloudFront los convierte en `index.html` para que
funcione el enrutado de la SPA, así que un error real con esos códigos llegaría al navegador
como una página HTML con estado 200. Se usan 401, 409, 410 y 422 en su lugar.

## Estado

La infraestructura está completa y sintetiza. De las Lambdas, **solo el encendido remoto está
implementado**; las otras cuatro responden 501 a propósito, para que el stack sea desplegable
y verificable antes de escribir la lógica. Su contrato está en
[`docs/tecnico/02-estados-api.md`](../docs/tecnico/02-estados-api.md).
