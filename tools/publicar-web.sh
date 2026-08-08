#!/usr/bin/env bash
# Publica el front. Hace falta porque `cdk deploy` NO sube el sitio: el stack solo crea el
# bucket, y los ficheros van aparte. Sin esto el despliegue dice "✅ no changes" con toda
# normalidad y sigue sirviendo la versión anterior — que es exactamente la trampa que se
# quiere evitar teniendo un comando.
set -euo pipefail

PERFIL="${AWS_PROFILE:-ventrax_infra_prod}"
BUCKET="${SPA_BUCKET:-l4d2-summon-web-211125402452}"
REGION="${AWS_REGION:-us-east-2}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"

cd "$RAIZ/web"
npm run build

# Cada grupo se sube UNA vez con su cabecera. Nada de subir todo y repasar después: `sync`
# solo copia lo que difiere, así que la segunda pasada se salta los ficheros que acaba de
# subir y la cabecera correcta nunca llega a aplicarse.
#
# `immutable` solo vale para nombres que cambian cuando cambia el contenido. Vite le mete un
# hash a lo de `assets/`, así que ahí es seguro. Para el resto —las miniaturas se llaman
# siempre `mapas/<codigo>.webp`— sería una promesa imposible de cumplir: al sustituir una
# imagen, quien ya la tuviera seguiría viendo la vieja un año sin llegar a preguntar. Pasó.
#
# Lo de abajo da lo mejor de ambos lados: CloudFront la guarda un año igual (y la purgamos
# nosotros al publicar), y el navegador revalida siempre — un 304 son doscientos bytes.
aws s3 sync dist "s3://$BUCKET" --delete --profile "$PERFIL" --region "$REGION" \
  --exclude "assets/*" \
  --cache-control "public,max-age=0,s-maxage=31536000,must-revalidate"

aws s3 sync dist/assets "s3://$BUCKET/assets" --delete --profile "$PERFIL" --region "$REGION" \
  --cache-control "public,max-age=31536000,immutable"

# index.html nunca se cachea en el navegador: es quien apunta a los assets nuevos.
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --profile "$PERFIL" --region "$REGION" \
  --cache-control "no-cache,must-revalidate"

DIST=$(aws cloudfront list-distributions --profile "$PERFIL" \
  --query "DistributionList.Items[?Aliases.Items[0]=='l4d2.ventrax.dev'].Id|[0]" --output text)
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" \
  --profile "$PERFIL" --query 'Invalidation.Status' --output text

echo "publicado; la invalidación tarda unos segundos en propagarse"
