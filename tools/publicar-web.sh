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

# Los assets llevan hash en el nombre: se cachean para siempre sin riesgo.
aws s3 sync dist "s3://$BUCKET" --delete --profile "$PERFIL" --region "$REGION" \
  --cache-control "public,max-age=31536000,immutable" --exclude "index.html"

# index.html NUNCA se cachea: es quien apunta a los assets nuevos.
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --profile "$PERFIL" --region "$REGION" \
  --cache-control "no-cache,must-revalidate"

DIST=$(aws cloudfront list-distributions --profile "$PERFIL" \
  --query "DistributionList.Items[?Aliases.Items[0]=='l4d2.ventrax.dev'].Id|[0]" --output text)
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" \
  --profile "$PERFIL" --query 'Invalidation.Status' --output text

echo "publicado; la invalidación tarda unos segundos en propagarse"
