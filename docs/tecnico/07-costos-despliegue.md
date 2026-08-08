# L4D2 Panel — Diseño técnico: COSTOS + DESPLIEGUE

> Dominio: **costos-deploy**. Fuente de verdad de producto: `../especificaciones-v1.md`
> (ADR **D14** = front S3+CloudFront, back Lambda Function URLs, DynamoDB; objetivo ~$0). Este
> documento **no** repite el inventario de recursos CDK (eso vive en el doc de infra/CDK); aquí
> están los **números de costo**, las **trampas de facturación**, el **despliegue paso a paso**, el
> **CI/CD**, el **certificado del lado de casa** y las **alarmas de presupuesto/uso**.
>
> Cuenta AWS **211125402452**, perfil SSO **`ventrax_infra_prod`**, región de cómputo **us-east-2**.
> El cert ACM de CloudFront va **obligatoriamente en us-east-1**. Zona Route 53 de `ventrax.dev` =
> **`Z0798505KCA3V0GU54OJ`**. Dominio del panel: **`l4d2.ventrax.dev`**.

---

## 0. TL;DR

1. **Costo neto-nuevo esperado del proyecto: $0.00/mes** en el camino feliz (todo cae en free
   tiers permanentes). El único renglón AWS **garantizado ≠ 0** es el **almacenamiento S3 de la
   SPA** — y es **sub-céntimo** (~$0.0005/mes por ~20 MB). La factura total seguirá leyendo
   **~$0.90/mes** por el **baseline preexistente ajeno** (Route 53 $0.50 + snapshots RDS
   huérfanos ~$0.37).
2. **Rango honesto:** **$0.00–$0.20/mes** neto-nuevo en operación normal; **$0.50–$2.00/mes** si se
   cae en una de las dos trampas (DynamoDB **on-demand**, o **CloudWatch Logs** con logging verboso).
   El **budget de $1** está calibrado precisamente para atrapar ese error de configuración.
3. **Dos trampas** que hay que evitar activamente: (a) **DynamoDB on-demand** no tiene free tier de
   requests → usar **provisioned 25/25** (sí tiene); (b) **CloudWatch Logs** cobra **$0.50/GB de
   ingesta** (la retención/almacenamiento a $0.03/GB es lo barato) → **no loguear por poll** +
   **retención 14 días**.
4. **La palanca de ahorro #1** es **cachear la lista pública de servidores en CloudFront** con TTL
   corto (3–5 s): desacopla el costo del **número de espectadores** (el driver dominante) y colapsa
   miles de polls en pocos hits al origen.
5. **Despliegue:** `cdk bootstrap` de **us-east-1** (pendiente; us-east-2 ya hecho) → `cdk deploy`
   desde la laptop con el perfil SSO → subir SPA a S3 → invalidar `/index.html` en CloudFront. El
   cert ACM us-east-1 se **valida solo** por DNS contra Route 53 (CDK crea los CNAME).
6. **CI/CD:** GitHub Actions con **OIDC solo para el FRONTEND** (deploy manual aprobado por
   Environment protection). El **CDK se despliega desde la laptop**, nunca desde CI.
7. **Lado de casa:** cert **Let's Encrypt** para el hostname DDNS del origen `/sourcebans`, emitido y
   renovado por **DNS-01 contra Route 53** (funciona con la PC intermitente; Caddy o certbot).
8. **Alarmas:** budget de costo **$1/mes** (SNS→email) + **segunda línea basada en USO** (alarmas
   CloudWatch sobre invocaciones/día de Lambda, throttles de DynamoDB e ingesta de Logs) que dispara
   **el mismo día** en vez de esperar a que el dinero ya se haya gastado.

---

## 1. Supuestos y dependencias sobre otros dominios

| # | Supuesto / dependencia | Dominio dueño | Qué asumo aquí |
|---|---|---|---|
| A1 | Lambdas `l4d2-auth`, `l4d2-api`, `l4d2-wol` (Function URLs, Node 20, arm64, 128 MB). | auth / reserva / wol | Uso sus **conteos de invocación** para el costo. No defino su lógica. |
| A2 | Tabla DynamoDB single-table **`l4d2-panel`**, PK/SK. | modelo-de-datos | Uso su **patrón de acceso** (lecturas por poll, escrituras por heartbeat) para dimensionar capacidad. |
| A3 | 1 distribución CloudFront sirviendo `l4d2.ventrax.dev` con comportamientos por path (`/*`→S3, `/api/*`→Lambda, `/auth/*`→Lambda, `/sourcebans/*`→origen de casa). | infra/CDK | Yo defino **política de cache**, **invalidación** y **costo**; la infra implementa la distribución. |
| A4 | El **agente local** hace polling HTTPS saliente cada ~10–15 s y actualiza el registro DDNS. | agente-local | Uso su cadencia para el costo; especifico el **IAM del DDNS** y el **cert del origen**. |
| A5 | La ruta `/sourcebans/*` apunta al **origen de casa** vía un hostname DDNS. | infra/CDK + agente | Yo especifico el **cert Let's Encrypt** de ese hostname y su renovación; la infra cablea el origin. |
| A6 | Los **schedules** (reintentos WoL, expiración de intents/cola, cierre de server vacío) usan **EventBridge Scheduler**. | reserva / wol | Uso su volumen para el costo (queda holgadamente en free tier). |

Si un conteo real difiere de los supuestos de §3, **solo cambian los números**, no el diseño: todo
está a 2–3 órdenes de magnitud por debajo de los límites de free tier.

---

## 2. Free tiers que aplican (los permanentes, no los de 12 meses)

> **Crítico:** el free tier de **12 meses** de S3 **ya expiró** (S3 cobra desde el primer byte). Lo
> que sostiene el "~$0" son los free tiers **permanentes ("Always Free")**, que **no** expiran.

| Servicio | Free tier permanente | ¿Nos alcanza? |
|---|---|---|
| **CloudFront** | **1 TB** transferencia salida/mes · **10,000,000** requests HTTP/S/mes · 2M invocaciones CloudFront Functions | Sí, con **enorme** holgura (usamos MB y ~10⁵ requests). |
| **Lambda** | **1,000,000** requests/mes · **400,000 GB-segundo/mes** | Sí (usamos ~10⁵ requests, ~10³–10⁴ GB-s). |
| **DynamoDB (provisioned)** | **25 RCU + 25 WCU** · **25 GB** almacenamiento | Sí **si es provisioned**. On-demand **NO** tiene free tier de requests (trampa §5.2). |
| **EventBridge Scheduler** | **14,000,000** invocaciones/mes | Sí, con holgura absurda (usamos ~10³). |
| **CloudWatch Logs** | **5 GB** combinados (ingesta + almacenamiento + scan de Insights)/mes | Sí **si el logging es sobrio** (trampa §5.1). |
| **CloudWatch Metrics** | 10 métricas custom · métricas AWS-vended (Lambda/DDB) gratis · 1M API req | Sí (las métricas de invocaciones/throttles son vended → gratis). |
| **CloudWatch Alarms** | **10 alarmas** standard-resolution | Sí (usamos 2–4). |
| **AWS Budgets** | **2 budgets** de costo gratis | Sí (usamos 1). |
| **SNS** | 1,000 notificaciones email/mes gratis | Sí (alertas esporádicas). |
| **ACM** | Certificados públicos **gratis** | Sí (cert de CloudFront). |
| **SSM Parameter Store** | Parámetros **standard** + throughput standard: **gratis** | Sí (secretos del auth doc; no usar "advanced"). |
| **S3** | **Ninguno permanente** (el de 12 meses expiró) | **Cobra desde el primer byte** — pero es sub-céntimo (§4.1). |
| **Route 53** | Ninguno; $0.50/zona/mes; queries **alias a recursos AWS = gratis** | Ya pagada; el alias a CloudFront no suma queries. |

---

## 3. Modelo de carga (los números que mueven el costo)

Todo el costo depende de **cuántas invocaciones** genera cada fuente. Estos son los supuestos
(declarados como tales; ajustar si la realidad difiere):

| Variable | Símbolo | Base | Rango | Notas |
|---|---|---|---|---|
| Horas/día que la PC está encendida | `H_pc` | 4 h | 1–12 h | Solo mientras alguien juega. Fuera de eso, **0 costo del agente**. |
| N servidores (tope) | `N` | 4 | 1–8 | Configurable (D6). |
| Intervalo de poll del **agente** | `T_ag` | 12 s | 10–15 s | Heartbeat + estado + recoger comandos. |
| Intervalo de poll de la **SPA** | `T_spa` | 8 s | 5–15 s | Lista de servidores en vivo. |
| Espectadores concurrentes promedio | `V` | 3 | 0–10 | Pestañas abiertas mirando la lista. |
| Horas/día de visualización activa | `H_view` | 4 h | 0–8 h | Cuánto tiempo hay pestañas abiertas. |
| Reservas "desde frío" (PC apagada)/día | `R_cold` | 3 | 0–10 | Cada una dispara WoL + reintentos. |

### 3.1 Invocaciones/mes derivadas (Lambda + CloudFront requests)

```
Agente          = (3600/T_ag) · H_pc · 30
                = (3600/12=300/h) · 4 · 30           = 36,000/mes    (24/7 peor caso: 216,000)

SPA SIN cache   = V · (3600/T_spa) · H_view · 30
                = 3 · (3600/8=450/h) · 4 · 30         = 162,000/mes   (peak 10 usu, 6h: 810,000)

SPA CON cache   = (3600/TTL) · H_view · 30            ← INDEPENDIENTE de V
 (TTL=5s)       = (720/h) · 4 · 30                     = 86,400/mes    (peak 6h: 129,600)

Auth (logins)   ~ decenas/día                          ≈ 1,000/mes
WoL + reintentos= R_cold · ~9 fires · 30               ≈ 810/mes
Scheduler total = one-shots por intent/cola/cierre     < 5,000/mes
```

**Total Lambda/mes (con cache, base):** 36,000 + 86,400 + 1,000 + 810 ≈ **124,000** → muy por debajo
del millón gratis. **Peor caso realista (sin cache, peak):** ~216,000 + 810,000 ≈ **1,03 M** → apenas
roza el free tier de Lambda (**+$0.005** de requests, y el cómputo sigue en el free tier de GB-s).

**Conclusión:** ni Lambda ni CloudFront son el riesgo de costo. El riesgo son las dos trampas (§5)
que operan **sobre esas mismas invocaciones**: si cada poll pega a **DynamoDB on-demand** o escribe
un **log verboso**, ~10⁶ eventos/mes empiezan a costar.

---

## 4. Costo real, servicio por servicio (con números)

Todos los precios en **us-east-2** (idénticos a us-east-1 para estos servicios). Escenario **base**
del §3, camino feliz (cache activo, DDB provisioned, logs sobrios).

### 4.1 S3 (SPA) — el único renglón garantizado ≠ 0

| Concepto | Precio | Uso base | Costo/mes |
|---|---|---|---|
| Almacenamiento Standard | $0.023/GB-mes | ~20 MB = 0.02 GB SPA | **$0.00046** |
| PUT/LIST (deploys) | $0.005/1,000 | ~500 objetos × pocos deploys | **~$0.00003** |
| GET desde CloudFront (miss) | $0.0004/1,000 | pocos miles (mayoría cacheada) | **~$0.00002** |
| Transferencia S3 → CloudFront | **$0** | toda | **$0** |

**S3 ≈ $0.0005/mes** (medio milésimo de dólar). Es literalmente "cobra desde el primer byte", pero
el byte cuesta nada. **No** poner versionado con muchas versiones viejas (acumula storage); si se
activa, poner lifecycle que expire versiones no-actuales a 30 días.

### 4.2 CloudFront

| Concepto | Precio (post free tier) | Uso base | Costo/mes |
|---|---|---|---|
| Requests HTTP/S | $0.01/10,000 | ~124,000 (< 10M gratis) | **$0** |
| Transferencia salida | ~$0.085/GB (< 1 TB gratis) | JSON pequeño + SPA ≈ 1–3 GB | **$0** |
| Invalidaciones | primeras **1,000 paths/mes gratis** | 2 paths/deploy (`/`, `/index.html`) | **$0** |

**CloudFront ≈ $0/mes.** Incluso el peak (~1 M requests, pocos GB) queda dentro del free tier.

### 4.3 Lambda (`l4d2-api`, `l4d2-auth`, `l4d2-wol`)

| Concepto | Precio (post free tier) | Uso base | Costo/mes |
|---|---|---|---|
| Requests | $0.20/1M (> 1M gratis) | ~124,000 | **$0** |
| Cómputo (arm64, 128 MB) | $0.0000133/GB-s (> 400k GB-s gratis) | 124k × 0.128 GB × ~0.1 s ≈ 1,600 GB-s | **$0** |
| Function URLs | **sin cargo** (a diferencia de API Gateway) | — | **$0** |

**Lambda ≈ $0/mes.** Aun el peak (~1 M req, ~13k GB-s) sigue en free tier o suma **< $0.01**.
Justificación de **arm64 + 128 MB**: el trabajo es I/O-bound (fetch a Steam, DynamoDB, RCON del
agente lo hace la PC); 128 MB basta y arm es ~20% más barato en duración — irrelevante en free tier
pero es la elección correcta por defecto.

### 4.4 DynamoDB (provisioned 25/25)

| Concepto | Precio | Uso base | Costo/mes |
|---|---|---|---|
| 25 RCU + 25 WCU provisioned | **free tier permanente** | picos < 25/25 (ver abajo) | **$0** |
| Almacenamiento | $0.25/GB-mes (> 25 GB gratis) | < 1 MB (decenas de ítems) | **$0** |

**Verificación de capacidad (que 25/25 alcanza):**
- Lecturas: con cache CloudFront, el origen lee la lista pocas veces/s; sin cache, peak ~10 polls ×
  (1/8 s) ≈ **1.25 lecturas/s** ≪ 25 RCU (25 lecturas/s eventually-consistent de 4 KB). Holgado.
- Escrituras: heartbeats del agente ~ (1 cada 12 s) + writes de intents/cola ≈ **< 1 escritura/s** ≪
  25 WCU. Holgado.

**DynamoDB ≈ $0/mes** — **siempre que sea provisioned** (ver trampa §5.2). No hace falta autoscaling
(sobra para hobby); si algún día 25/25 se queda corto, se sube el fijo o se activa on-demand **solo
entonces**.

### 4.5 EventBridge Scheduler

| Concepto | Precio | Uso base | Costo/mes |
|---|---|---|---|
| Invocaciones | $1.00/1M (> **14M gratis**) | < 5,000 | **$0** |

**Scheduler ≈ $0/mes.** El free tier de **14 millones** de invocaciones/mes es 3 órdenes de magnitud
mayor que nuestro uso; ni con un tick de 1 minuto permanente (43,200/mes) se sale.

### 4.6 Route 53 / ACM / SSM / SNS / Budgets

| Servicio | Costo/mes | Nota |
|---|---|---|
| Route 53 zona `ventrax.dev` | $0.50 (ya se paga) | Compartida; **no** es neto-nuevo de este proyecto. |
| Route 53 queries alias→CloudFront | $0 | Alias a recurso AWS no cobra queries. |
| Route 53 queries record DDNS `/sourcebans` (no-alias) | ~$0 | Solo CloudFront resuelve en miss; volumen ínfimo. Cambios de record: gratis. |
| ACM (cert CloudFront, us-east-1) | $0 | Cert público. |
| SSM Parameter Store (standard) | $0 | Secretos del auth doc. **No** usar advanced tier. |
| SNS (alertas) | $0 | < 1,000 emails/mes. |
| AWS Budgets | $0 | 1 de 2 gratis. |

### 4.7 Cuadro resumen

| Servicio | Base ($/mes) | Peak realista ($/mes) | Si se cae en la trampa |
|---|---|---|---|
| S3 (SPA) | 0.0005 | 0.001 | — |
| CloudFront | 0 | 0 | — |
| Lambda | 0 | 0.01 | — |
| DynamoDB | 0 | 0 | **0.30–0.50** (on-demand, §5.2) |
| EventBridge Scheduler | 0 | 0 | — |
| CloudWatch Logs | 0 | 0 | **0.50–2.00** (logging verboso, §5.1) |
| Route 53 / ACM / SSM / SNS | 0 (neto-nuevo) | 0 | — |
| **NETO-NUEVO del proyecto** | **~$0.001** | **~$0.01** | **$0.50–$2.00** |
| Baseline preexistente ajeno | 0.87 | 0.87 | 0.87 |
| **Factura total leída** | **~$0.87** | **~$0.88** | **~$1.4–2.9** |

---

## 5. Las dos trampas de facturación

### 5.1 CloudWatch Logs — ingesta vs retención

**La plata está en la INGESTA, no en la retención.**

| Dimensión | Precio | Comentario |
|---|---|---|
| **Ingesta** (Standard) | **$0.50/GB** | Lo caro. Se cobra por byte que **entra** al log group. |
| Ingesta (Infrequent Access) | $0.25/GB | Clase más barata; sin Live Tail/metric filters. Opcional. |
| Almacenamiento/retención | **$0.03/GB-mes** | Lo barato. Guardar no es el problema. |
| Free tier | **5 GB/mes** combinados (ingesta+storage+scan) | Sobra si no se loguea por poll. |

**La trampa:** un log de INFO/DEBUG por **cada** invocación. Con ~10⁶ invocaciones/mes (peak) y un
log de 5–10 KB (request+response JSON), son **5–10 GB/mes** → 0–5 GB sobre el free tier → **hasta
~$2.50/mes** solo de logs. Y como la ingesta ya ocurrió, **poner retención corta NO recupera ese
gasto** (la retención solo afecta el $0.03/GB de guardar, que era despreciable).

**Mitigaciones (todas baratas, aplicarlas):**
1. **No loguear en el hot path.** Los handlers de `GET /api/servers` (poll de la SPA) y del
   heartbeat del agente corren a nivel **WARN/ERROR**, no INFO. Nada de "request recibido / response
   enviado" por poll.
2. **Retención 14 días** en todos los log groups (en CDK: `logRetention: RetentionDays.TWO_WEEKS`).
   Barato pero evita acumulación indefinida.
3. **Un log estructurado de una línea por evento de negocio** (reserva creada, server levantado,
   poweroff), no por request de sondeo. Eso es lo que sí querés poder auditar.
4. (Opcional) clase **Infrequent Access** para el log group del `l4d2-api` si el volumen creciera.
5. **Alarma** sobre `AWS/Logs IncomingBytes` por log group (§9.2) para enterarte el **mismo día**.

### 5.2 DynamoDB — provisioned vs on-demand

| Modo | Free tier de requests | Precio de request | Para esta carga |
|---|---|---|---|
| **Provisioned 25/25** | **Sí**: 25 RCU + 25 WCU permanentes | capacidad fija (gratis dentro del free tier) | **$0** — la elección correcta. |
| **On-demand** | **No** (solo el 25 GB de storage es común) | $0.25/M lecturas · **$1.25/M** escrituras | ~$0.30–0.50/mes con polling. |

**La trampa:** on-demand se vende como "no pienses en capacidad", y para muchas apps es lo cómodo —
**pero no tiene free tier de requests**. Con un patrón de **polling** (10⁵–10⁶ lecturas/escrituras al
mes), on-demand cobra desde la primera operación mientras provisioned 25/25 es **gratis** y **sobra**
para esta carga (§4.4).

**Decisión: DynamoDB en modo PROVISIONED, 25 RCU / 25 WCU** (en CDK:
`billingMode: PROVISIONED, readCapacity: 25, writeCapacity: 25`, **sin** autoscaling). Es
contraintuitivo (el default "moderno" es on-demand), por eso se documenta explícito. Riesgo residual:
si un día un bug hace un loop de escritura y satura 25 WCU, DynamoDB **throttlea** (no cobra de más) y
la **alarma de throttles** (§9.2) avisa — mejor que una factura sorpresa de on-demand.

---

## 6. Despliegue

### 6.1 Prerrequisitos (una vez)

```bash
# Sesión SSO (perfil ya configurado en sesiones previas)
aws sso login --profile ventrax_infra_prod
aws sts get-caller-identity --profile ventrax_infra_prod   # -> Account 211125402452

# Node/CDK
node -v        # >= 20
npm i -g aws-cdk    # o usar npx cdk (recomendado, versión pinneada en package.json)
```

### 6.2 Bootstrap CDK — falta us-east-1

**us-east-2 ya está bootstrapeado** (sesiones previas). **us-east-1 falta** y es **obligatorio**:
el cert ACM de CloudFront **solo** puede vivir en us-east-1, y CDK necesita el bucket/roles de
bootstrap ahí para desplegar el stack del cert.

```bash
# Bootstrap SOLO de us-east-1 (us-east-2 ya hecho)
npx cdk bootstrap aws://211125402452/us-east-1 --profile ventrax_infra_prod

# Verificar ambos
aws cloudformation describe-stacks --stack-name CDKToolkit \
  --region us-east-1 --profile ventrax_infra_prod --query 'Stacks[0].StackStatus'
aws cloudformation describe-stacks --stack-name CDKToolkit \
  --region us-east-2 --profile ventrax_infra_prod --query 'Stacks[0].StackStatus'
```

> **Nota de costo:** el bootstrap de us-east-1 crea un bucket `cdk-hnb659fds-assets-...-us-east-1`.
> Guarda assets diminutos (el template del cert) → **sub-céntimo**. Aceptable.

### 6.3 Arquitectura de stacks (para el deploy; el detalle de recursos va en el doc de infra)

Dos stacks por la restricción de región del cert:

```
L4d2CertStack   (env.region = us-east-1)  → ACM Certificate  l4d2.ventrax.dev  (DNS-validated)
                                             exporta certificateArn
L4d2PanelStack  (env.region = us-east-2)  → S3, CloudFront, Lambdas, DynamoDB, Scheduler, Budgets
                                             consume el cert vía crossRegionReferences
```

En `bin/app.ts`, ambos stacks con `env: { account: '211125402452', region: ... }` y
**`crossRegionReferences: true`** en el `App`/stacks para que us-east-2 lea el ARN del cert de
us-east-1 sin custom resources frágiles. La zona se resuelve con
`HostedZone.fromHostedZoneAttributes({ hostedZoneId: 'Z0798505KCA3V0GU54OJ', zoneName: 'ventrax.dev' })`
(evita `fromLookup`, que requiere creds en synth-time y cachea en `cdk.context.json`).

### 6.4 Validación del cert ACM en us-east-1 vía Route 53 (paso a paso)

**Camino recomendado (automático con CDK):** dejar que CDK cree el cert y **auto-valide** por DNS.

```ts
// dentro de L4d2CertStack (us-east-1)
const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
  hostedZoneId: 'Z0798505KCA3V0GU54OJ',
  zoneName: 'ventrax.dev',
});
const cert = new acm.Certificate(this, 'PanelCert', {
  domainName: 'l4d2.ventrax.dev',
  validation: acm.CertificateValidation.fromDns(zone),   // CDK crea el CNAME de validación
});
```

Al `cdk deploy L4d2CertStack`, CloudFormation:
1. Pide el cert a ACM (estado `PENDING_VALIDATION`).
2. **Crea automáticamente** el record CNAME `_<hash>.l4d2.ventrax.dev → _<hash>.acm-validations.aws`
   en la zona `Z0798505KCA3V0GU54OJ`.
3. Espera a que ACM lo detecte y pase a `ISSUED` (1–5 min típico). El deploy **se bloquea** hasta que
   emite; si tarda, es DNS propagando.

Como `ventrax.dev` **ya está en Route 53** y CDK tiene permisos sobre la zona, **no hay pasos
manuales de DNS**. El CNAME de validación es **permanente** (no borrarlo: ACM lo re-chequea en cada
renovación automática, que ACM hace sola y gratis).

**Camino manual (equivalente, para entender/depurar):**

```bash
# 1) Pedir el cert en us-east-1
CERT_ARN=$(aws acm request-certificate --region us-east-1 --profile ventrax_infra_prod \
  --domain-name l4d2.ventrax.dev \
  --validation-method DNS \
  --query CertificateArn --output text)

# 2) Leer el CNAME de validación que ACM espera
aws acm describe-certificate --region us-east-1 --profile ventrax_infra_prod \
  --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
# -> { Name: "_xxxx.l4d2.ventrax.dev.", Type: "CNAME", Value: "_yyyy.acm-validations.aws." }

# 3) Crear ese CNAME en Route 53 (change-batch con el Name/Value de arriba)
aws route53 change-resource-record-sets --profile ventrax_infra_prod \
  --hosted-zone-id Z0798505KCA3V0GU54OJ \
  --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{
    "Name":"_xxxx.l4d2.ventrax.dev.","Type":"CNAME","TTL":300,
    "ResourceRecords":[{"Value":"_yyyy.acm-validations.aws."}]}}]}'

# 4) Esperar ISSUED
aws acm wait certificate-validated --region us-east-1 --profile ventrax_infra_prod \
  --certificate-arn "$CERT_ARN"
```

> El registro `A/AAAA` **alias** de `l4d2.ventrax.dev → CloudFront` lo crea el `L4d2PanelStack`
> (`ARecord` + `AaaaRecord` alias a la distribución). No confundir con el CNAME de **validación** del
> cert.

### 6.5 Deploy de la infra (desde la laptop)

```bash
cd ~/modules/personal/l4d2-panel/infra    # (o donde viva el proyecto CDK)
npm ci
npx cdk diff  --profile ventrax_infra_prod --all
npx cdk deploy L4d2CertStack --profile ventrax_infra_prod        # us-east-1, primero (cert)
npx cdk deploy L4d2PanelStack --profile ventrax_infra_prod       # us-east-2 (consume el cert)
# o de una: npx cdk deploy --all --profile ventrax_infra_prod --require-approval never
```

Guardar los outputs útiles (van a `cdk-outputs.json` con `--outputs-file`): `DistributionId`,
`SpaBucketName`, URLs de las Function URLs. Se usan en el deploy del front (§6.6) y en CI (§7).

### 6.6 Subir la SPA a S3 + invalidar CloudFront

**Estrategia de cache** (minimiza invalidaciones → se queda en las 1,000 gratis/mes):
- Assets con **hash en el nombre** (`app.3f9a.js`, `main.7c2.css`) → `Cache-Control: immutable`,
  1 año. **Nunca** se invalidan (cambian de nombre en cada build).
- `index.html` → `Cache-Control: no-cache` (siempre revalida) → **solo** se invalida ese.

```bash
DIST_ID=$(jq -r '.L4d2PanelStack.DistributionId' cdk-outputs.json)
BUCKET=$(jq -r '.L4d2PanelStack.SpaBucketName' cdk-outputs.json)

# 1) Assets con hash: immutable, excluir el HTML
aws s3 sync ./dist "s3://$BUCKET" --delete --profile ventrax_infra_prod \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html"

# 2) index.html: no-cache
aws s3 cp ./dist/index.html "s3://$BUCKET/index.html" --profile ventrax_infra_prod \
  --cache-control "no-cache" --content-type "text/html"

# 3) Invalidar SOLO index.html y la raíz (2 paths -> gratis)
aws cloudfront create-invalidation --profile ventrax_infra_prod \
  --distribution-id "$DIST_ID" --paths "/" "/index.html"
```

> **No** usar `--paths "/*"`: aunque el wildcard cuenta como 1 sola path, invalida todo y fuerza
> re-fetch de los assets inmutables (transferencia innecesaria). Con la estrategia de hashing, basta
> invalidar `/index.html`.

---

## 7. CI/CD pragmático

**Regla:** **CDK se despliega SIEMPRE desde la laptop** (SSO, un solo operador, permisos amplios →
no vale la pena exponerlos a CI). **Solo el FRONTEND** se despliega por GitHub Actions con **OIDC**,
y **con aprobación manual**. Rationale hobby: el front cambia seguido y es de bajo riesgo (subir
archivos estáticos + invalidar); la infra cambia poco y es de alto blast-radius.

### 7.1 OIDC: proveedor + rol IAM (crear una vez, se puede desde CDK o a mano)

```
IAM OIDC provider:  token.actions.githubusercontent.com   (audience sts.amazonaws.com)
IAM role:           l4d2-frontend-deployer
```

**Trust policy** (acota a repo + Environment "production" para exigir aprobación):

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::211125402452:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:Ventrax-01/l4d2-panel:environment:production"
    }
  }
}
```

**Permission policy** (mínimo: solo tocar el bucket de la SPA e invalidar la distribución):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["s3:PutObject","s3:DeleteObject","s3:ListBucket"],
      "Resource": ["arn:aws:s3:::<spa-bucket>","arn:aws:s3:::<spa-bucket>/*"] },
    { "Effect": "Allow",
      "Action": ["cloudfront:CreateInvalidation"],
      "Resource": ["arn:aws:cloudfront::211125402452:distribution/<DIST_ID>"] }
  ]
}
```

> El repo del panel se asume bajo la cuenta GitHub **personal `Ventrax-01`** (ver memoria "Cuentas
> GitHub"). Ajustar el `sub` al owner/repo real. El deploy usa `us-east-2` para S3/CloudFront API.

### 7.2 Workflow (deploy manual aprobado)

`.github/workflows/deploy-frontend.yml`:

```yaml
name: deploy-frontend
on:
  workflow_dispatch: {}          # SOLO manual (botón "Run workflow")
permissions:
  id-token: write                # requerido para OIDC
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production       # <- Environment protection: exige approval antes de correr
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build        # produce ./dist con assets hasheados
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::211125402452:role/l4d2-frontend-deployer
          aws-region: us-east-2
      - name: Subir SPA
        run: |
          aws s3 sync ./dist "s3://${{ vars.SPA_BUCKET }}" --delete \
            --cache-control "public,max-age=31536000,immutable" --exclude index.html
          aws s3 cp ./dist/index.html "s3://${{ vars.SPA_BUCKET }}/index.html" \
            --cache-control "no-cache" --content-type text/html
      - name: Invalidar CloudFront
        run: |
          aws cloudfront create-invalidation \
            --distribution-id "${{ vars.CF_DIST_ID }}" --paths "/" "/index.html"
```

**Aprobación manual:** en GitHub → Settings → Environments → `production` → *Required reviewers* =
Ventrax. Con eso, aunque el job se dispare, **espera aprobación humana** antes de asumir el rol y
subir. `SPA_BUCKET` y `CF_DIST_ID` van como **Environment variables** (no secretos; el OIDC ya es la
credencial).

**Lo que NO se hace en CI (a propósito):** `cdk deploy`, tocar DynamoDB, SSM, Lambdas o la zona
Route 53. Eso es de la laptop. Nada de credenciales AWS de larga vida en GitHub (OIDC = tokens
efímeros).

---

## 8. Certificado del lado de casa (origen `/sourcebans`)

CloudFront enruta `/sourcebans/*` al **origen de casa** por un hostname DDNS. CloudFront habla con
orígenes custom por **HTTPS y valida el certificado** contra el **dominio del origen** y contra una
**CA pública de confianza** (no acepta self-signed con `OriginProtocolPolicy=https-only`). Por eso la
PC necesita un **cert público real** para su hostname de origen.

### 8.1 Hostname del origen + DDNS por Route 53

- Origen: **`home-l4d2.ventrax.dev`** (un record **A** dedicado en la zona `Z0798505KCA3V0GU54OJ`,
  distinto del alias de CloudFront de `l4d2.ventrax.dev`).
- **DDNS:** el **agente** actualiza ese record con la IP pública actual de casa vía
  `route53 ChangeResourceRecordSets` cuando cambia. **TTL 60 s** para propagación rápida.
- **IAM del agente** (usuario IAM `l4d2-home-agent` con access key, o rol si algún día hay SSM
  Hybrid) — permiso mínimo, **solo ese record**:

```json
{ "Effect": "Allow",
  "Action": "route53:ChangeResourceRecordSets",
  "Resource": "arn:aws:route53:::hostedzone/Z0798505KCA3V0GU54OJ",
  "Condition": { "ForAllValues:StringEquals": {
    "route53:ChangeResourceRecordSetsNormalizedRecordNames": ["home-l4d2.ventrax.dev"] } } }
```
(más `route53:ListResourceRecordSets` / `GetChange` de lectura sobre la misma zona). **Costo:** los
cambios de record son **gratis**; queries sobre este record no-alias son ínfimas.

### 8.2 Cert Let's Encrypt por DNS-01 (no HTTP-01)

**Por qué DNS-01 y no HTTP-01:** la PC está **apagada la mayor parte del tiempo** y detrás de una IP
cambiante; HTTP-01 exige el puerto 80 alcanzable en el instante del challenge. **DNS-01 valida
poniendo un TXT en Route 53** → funciona aunque la PC esté offline en ese momento y no depende de la
IP. Además ya tenemos creds de Route 53 (mismas del DDNS, o un usuario aparte con permiso al TXT
`_acme-challenge`).

**Opción recomendada — Caddy** (reverse proxy delante del panel PHP de SourceBans++), con el módulo
DNS de Route 53: obtiene y **renueva solo**, ideal para una caja intermitente.

```
# Caddyfile (en la PC de casa)
home-l4d2.ventrax.dev {
    tls {
        dns route53 {
            # credenciales por env: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (usuario acotado)
        }
    }
    handle_path /sourcebans/* {
        reverse_proxy 127.0.0.1:8081   # el vhost PHP de SourceBans++ (Apache/php-fpm)
    }
}
```

**Alternativa — certbot** con el plugin `dns-route53`:

```bash
sudo certbot certonly --dns-route53 -d home-l4d2.ventrax.dev \
  --non-interactive --agree-tos -m alonsolgm001@gmail.com
# cert en /etc/letsencrypt/live/home-l4d2.ventrax.dev/ ; nginx/apache lo referencian
```

### 8.3 Renovación con la PC intermitente

Los certs Let's Encrypt duran **90 días** y se renuevan a los **60** (ventana de 30 días). Con Caddy,
la renovación es automática **cada vez que el proceso corre** y detecta que faltan < 30 días —
mientras la PC se encienda **al menos una vez cada ~30 días**, siempre renueva a tiempo. Con certbot,
en vez del timer estándar (que asume la caja siempre viva), disparar el intento **al boot** y también
un timer diario:

```ini
# /etc/systemd/system/certbot-renew-onboot.service  (oneshot, WantedBy=multi-user.target)
[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --dns-route53 --quiet --deploy-hook "systemctl reload caddy"
```
Como la PC se enciende cada vez que alguien juega, en la práctica se enciende muchísimo más seguido
que cada 30 días → la renovación **nunca** cae fuera de ventana. Si Ventrax se fuera 2 meses sin que
nadie juegue, el cert vencería; mitigación trivial: un **encendido programado** (WoL) mensual de
mantenimiento, o dejar que el primer `/sourcebans` post-vencimiento la despierte y Caddy renueve en
el arranque (el panel queda unos minutos con cert vencido hasta que renueva — aceptable para hobby).

### 8.4 Comportamiento de CloudFront cuando la PC está apagada

Origen inalcanzable → CloudFront devuelve **502/504**. Esto es **esperado** (la PC normalmente está
apagada). El manejo del "despertando…" del operador (wake-on-uso, D13) vive en el flujo de
reserva/SPA, **no** aquí; este dominio solo garantiza que **cuando la PC está encendida**, el cert es
válido y CloudFront confía en el origen. Config de CloudFront para este origin (requisito para
infra): `OriginProtocolPolicy=https-only`, `OriginSSLProtocols=[TLSv1.2]`, timeouts de origen cortos
(p.ej. 10 s) para que el 502 llegue rápido y la página de wake reaccione.

---

## 9. Alarmas: presupuesto ($1) + segunda línea por USO

Dos capas, porque **el costo va con retraso** (los budgets ven el gasto ~24 h tarde y solo después de
que ya se gastó) y **el uso va en tiempo casi real** (una alarma de invocaciones dispara el mismo
día, antes de que el error se vuelva dinero).

### 9.1 Budget de costo $1/mes (capa lenta, red de seguridad)

```
AWS Budgets  ->  budget de COSTO, límite $1.00/mes
  - alerta 1: ACTUAL >= 80%  ($0.80)  -> SNS topic  l4d2-alertas  -> email alonsolgm001@gmail.com
  - alerta 2: FORECAST >= 100% ($1.00) -> mismo SNS
```
Gratis (1 de 2 budgets). El **$1** está elegido a propósito **por encima** del baseline (~$0.87): así
la alarma **no** se dispara por el ruido preexistente, pero **sí** salta si el proyecto empieza a
sumar $0.15–0.20 de más (exactamente el tamaño de las trampas §5). Si el baseline se limpia (§10),
bajar el umbral a $0.50.

### 9.2 Segunda línea por USO (capa rápida, CloudWatch Alarms → mismo SNS)

Todas usan **métricas AWS-vended (gratis)** y caben en las **10 alarmas gratis**:

| Alarma | Métrica | Umbral | Qué atrapa |
|---|---|---|---|
| **Invocaciones Lambda/día** | `AWS/Lambda Invocations` (Sum, período 1 día, por función o total) | **> 100,000/día** | Loop de polling desbocado (front o agente pegando sin backoff). Base ~4,000/día → 100k es 25× → señal clara. |
| **Throttles DynamoDB** | `AWS/DynamoDB ReadThrottleEvents` + `WriteThrottleEvents` (Sum) | **> 0** sostenido (2 de 3 períodos de 5 min) | 25/25 provisioned superado (capacidad corta **o** hot loop). Antes era invisible con on-demand. |
| **Ingesta de Logs/día** | `AWS/Logs IncomingBytes` (Sum, por log group, 1 día) | **> 150 MB/día** (~4.5 GB/mes ≈ free tier) | Logging verboso (trampa §5.1) **antes** de superar los 5 GB gratis. |
| (opcional) **Errores Lambda** | `AWS/Lambda Errors` (Sum, 5 min) | **> 10** | No es costo, pero un handler que revienta en loop puede reintentar y gastar; útil de todos modos. |

Rationale de por qué esta segunda línea importa **más** que el budget para este proyecto: el peor
caso de costo aquí **no** es tráfico legítimo (eso es free tier), es un **bug** (poll sin backoff,
log por request, DDB mal configurado). Esos bugs se ven en **invocaciones/throttles/ingesta el mismo
día**; para cuando el budget de costo reaccione, ya pasaron horas de gasto. Las alarmas de uso son la
detección temprana; el budget es la red final.

---

## 10. Recomendaciones de ahorro (priorizadas)

| # | Recomendación | Ahorro / efecto | Esfuerzo |
|---|---|---|---|
| **1** | **Cachear `GET /api/servers` en CloudFront** con TTL corto (3–5 s, `Cache-Control: public, max-age=3` desde la Lambda + CachePolicy con minTTL=0). Desacopla el costo del **número de espectadores** y colapsa el driver dominante (§3.1). | Convierte 810k → ~130k invocaciones/mes en el peak; blinda contra "se viralizó la lista". | Bajo |
| **2** | **DynamoDB PROVISIONED 25/25** (no on-demand). | Evita la trampa §5.2 (~$0.30–0.50/mes). | Trivial (1 flag CDK) |
| **3** | **Logs sobrios + retención 14 días.** WARN en hot paths, una línea por evento de negocio. | Evita la trampa §5.1 (hasta ~$2.50/mes). | Bajo |
| **4** | **Backoff de poll en la SPA:** poll rápido (5 s) **solo** durante un intent activo; lento (30–60 s) en idle; **pausar** con `document.hidden` (Page Visibility API) cuando la pestaña no está visible. | Recorta invocaciones y ancho de banda; alarga el free tier. | Bajo |
| **5** | **Assets hasheados `immutable` + invalidar solo `/index.html`.** | Se queda en las 1,000 invalidaciones gratis; evita re-fetch masivo. | Trivial |
| **6** | **Limpiar el baseline preexistente:** borrar los **snapshots RDS huérfanos** (~$0.37/mes) — es el **mayor dólar real** de la factura hoy y **no** es de este proyecto. | ~$4.4/año de puro desperdicio. | Bajo (1 comando) |
| **7** | **Un solo entorno** (sin dev/prod duplicado): una distribución, un bucket, una tabla. | Evita duplicar cualquier renglón que sí cobra (S3). | — (decisión) |
| **8** | **No usar** SSM **advanced** parameters, ni NAT/VPC, ni API Gateway, ni CloudWatch dashboards de pago, ni Cognito. | Cada uno rompería el "~$0". Ya están fuera por diseño (D14). | — (no hacer) |

Comando de la #6 (revisar antes de borrar; identificar los huérfanos):

```bash
aws rds describe-db-snapshots --profile ventrax_infra_prod --region us-east-2 \
  --snapshot-type manual --query 'DBSnapshots[].{id:DBSnapshotIdentifier,gb:AllocatedStorage,t:SnapshotCreateTime}'
# revisar cuáles no corresponden a ninguna DB viva, y:
# aws rds delete-db-snapshot --db-snapshot-identifier <id> --profile ventrax_infra_prod --region us-east-2
```
(Repetir en cualquier otra región donde aparezcan; el baseline no dice la región exacta — verificar
us-east-1 y us-east-2.)

---

## 11. Runbook de despliegue inicial (punta a punta)

Orden ejecutable, de cero a `l4d2.ventrax.dev` sirviendo:

```
[ 1] aws sso login --profile ventrax_infra_prod ; aws sts get-caller-identity
[ 2] cdk bootstrap aws://211125402452/us-east-1 --profile ventrax_infra_prod   # us-east-2 ya hecho
[ 3] Poblar SSM params del auth doc (jwt-secret, steam/web-api-key, cf-origin-secret):
     openssl rand -base64 48 | aws ssm put-parameter --name /l4d2-panel/auth/jwt-secret \
       --type SecureString --value file:///dev/stdin --profile ventrax_infra_prod --region us-east-2
     (idem web-api-key y cf-origin-secret)
[ 4] cdk deploy L4d2CertStack  --profile ventrax_infra_prod    # us-east-1; valida DNS solo (§6.4)
[ 5] cdk deploy L4d2PanelStack --profile ventrax_infra_prod --outputs-file cdk-outputs.json
     -> DistributionId, SpaBucketName, Function URLs, ARecord alias l4d2.ventrax.dev -> CloudFront
[ 6] Build + subir SPA a S3 + invalidar /index.html (§6.6)
[ 7] Verificar: curl -I https://l4d2.ventrax.dev            -> 200, cert válido
                curl https://l4d2.ventrax.dev/api/servers   -> 200 JSON (lista)
                abrir /auth/steam/login                     -> redirige a Steam
[ 8] Login con Steam una vez -> tomar el SteamID64 -> set operador=true (comando del auth doc §11)
--- Lado de casa (Ansible, extiende l4d2-fleet) ---
[ 9] Crear usuario IAM l4d2-home-agent (Route53 record + Let's Encrypt DNS-01) -> access key en la PC
[10] Ansible: instalar MySQL/MariaDB + SourceBans++ + panel PHP + agente + Caddy (§8.2)
[11] Caddy obtiene cert para home-l4d2.ventrax.dev (DNS-01 Route53) ; agente publica la IP (DDNS)
[12] Verificar origen: curl -I https://home-l4d2.ventrax.dev/sourcebans/  (PC encendida) -> 200
[13] Verificar ruta CloudFront: https://l4d2.ventrax.dev/sourcebans/ (PC encendida) -> panel
--- Observabilidad / guardarraíles ---
[14] Crear SNS topic l4d2-alertas + suscripción email (confirmar el correo)
[15] Budget de costo $1 (§9.1) + alarmas de uso (§9.2) apuntando al SNS
[16] Prueba de humo: reservar desde frío (PC apagada) -> WoL -> boot -> server -> steam://connect
[17] CI/CD: crear OIDC provider + rol l4d2-frontend-deployer + Environment "production" con reviewer
```

---

## 12. Honestidad sobre la incertidumbre

- **Lo que sé con alta confianza (verificado contra pricing AWS ene-2026):** free tiers permanentes de
  CloudFront (1 TB / 10M req), Lambda (1M req / 400k GB-s), DynamoDB provisioned (25/25 + 25 GB),
  EventBridge Scheduler (**14M invocaciones/mes gratis**), CloudWatch Logs (**5 GB**, ingesta
  **$0.50/GB**, storage $0.03/GB), 10 alarmas gratis, 2 budgets gratis, ACM público gratis, S3 sin
  free tier permanente ($0.023/GB-mes). Con esos números, **el neto-nuevo del proyecto es ~$0** con
  certeza estructural (estamos 2–3 órdenes de magnitud bajo cada límite).
- **Lo que NO puedo predecir (mueve el rango, no el veredicto):** las horas reales de juego (`H_pc`),
  cuántos espectadores dejan la pestaña abierta (`V`, `H_view`) y cuántas reservas desde frío hay al
  día. Duplicar todos esos supuestos **sigue** dando $0 en free tier; lo único que sacaría al proyecto
  de "$0" es **caer en una trampa** (§5) o un **bug de loop**, y para ambos existe la alarma de uso.
- **Lo que asumí de otros dominios** (§1): nombres de Lambdas/tabla, que los schedules usan
  EventBridge Scheduler, y que el origen DDNS es un record en Route 53. Si algo difiere, cambian
  nombres/constantes, no las conclusiones de costo.
- **El baseline de $0.87/mes es ajeno** a este proyecto (Route 53 + snapshots RDS huérfanos). La
  factura total leerá ~$0.87–0.90 aunque el proyecto aporte casi nada; la recomendación #6 (§10)
  ataca el pedazo desperdiciado.

---

## 13. Qué NO hacer (evitar sobre-ingeniería y evitar cobros)

- **No** DynamoDB on-demand (§5.2). **No** autoscaling de DynamoDB (25/25 fijo sobra).
- **No** loguear por request en hot paths; **no** dejar log groups sin retención (§5.1).
- **No** invalidar `/*` en CloudFront; hashear assets e invalidar solo `/index.html` (§6.6).
- **No** API Gateway (Function URLs son gratis), **no** VPC/NAT (NAT cuesta ~$32/mes — jamás), **no**
  Cognito, **no** SSM advanced tier, **no** CloudWatch dashboards de pago, **no** WAF (para hobby, el
  header secreto CF→origen del auth doc basta).
- **No** correr `cdk deploy` desde CI (solo el front por OIDC con approval; §7).
- **No** self-signed en el origen de casa (CloudFront lo rechaza; usar Let's Encrypt, §8).
- **No** duplicar entornos dev/prod; un solo stack (§10 #7).
- **No** activar CloudTrail data events, ni S3 request metrics, ni EventBridge en modo custom-events
  masivo (todos tienen renglones que cobran) — nada de eso hace falta.

---

## 14. Preguntas abiertas / pendientes menores

- **Región exacta de los snapshots RDS huérfanos** del baseline (verificar us-east-1 **y** us-east-2)
  para poder borrarlos (§10 #6).
- **Owner/repo real** del frontend en GitHub para fijar el `sub` del trust policy OIDC (asumido
  `Ventrax-01/l4d2-panel`; confirmar contra la memoria "Cuentas GitHub").
- **¿Caddy o certbot+nginx** en la PC? (§8.2) Recomendado **Caddy** por auto-renovación en caja
  intermitente; decisión final del dominio agente-local/infra-casa.
- **TTL exacto del cache de `/api/servers`** (3 s vs 5 s vs 10 s): trade-off frescura de la lista vs
  hits al origen; arrancar en **5 s** y ajustar observando (§10 #1).
- **`crossRegionReferences` vs stack de cert manual:** confirmar la versión de CDK soporta
  `crossRegionReferences` limpio (CDK v2 sí); si diera problemas, alternativa = exportar el
  `certificateArn` por SSM Parameter en us-east-1 y leerlo con `StringParameter.valueForStringParameter`
  region-cruzada vía custom resource. Preferir `crossRegionReferences`.
```

