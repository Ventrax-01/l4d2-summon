# Miniaturas de mapa

Una por capítulo de Left 4 Dead 2, nombrada con el código del mapa que reporta el servidor
(`c1m1_hotel.webp`). **Añadir o reemplazar un mapa es dejar aquí su `.webp`**: no hay que tocar
código. Si falta el archivo, la tarjeta cae al degradado de la campaña y no se rompe.

## Qué imágenes son

Son las **miniaturas oficiales que el propio juego usa** en su selector de mapas: 256×128 en los
archivos de Left 4 Dead 2. Se obtienen del wiki de Left 4 Dead mediante su API de MediaWiki (el
HTML del wiki está tras un desafío de Cloudflare; la API es la interfaz pública).

Se eligieron frente a las capturas de jugadores que también hay en el wiki —bastante más grandes,
hasta 1440×900— por **consistencia**: las oficiales son todas del mismo estilo y encuadre,
mientras que las capturas varían mucho entre sí y algunas ni siquiera corresponden al mapa.

Se guardan **tal cual, sin recortar ni ampliar**. El encuadre lo hace el CSS de la tarjeta
(`background-size: cover` centrado), así que sustituir una imagen por otra de mayor resolución
funciona sin cambiar nada más.

> **Pendiente:** estas imágenes son pequeñas y se ven algo blandas al escalarlas a la tarjeta.
> Está previsto reemplazarlas por versiones limpias en mayor resolución. Basta con dejar el nuevo
> `.webp` con el mismo nombre.

Se sirven desde nuestro propio CDN, nunca enlazadas al wiki: enlazar de fuera usa ancho de banda
ajeno, las URLs llevan un hash de revisión que cambia, y rompería la política de seguridad del
sitio.

## Regenerar

`tools/descargar-mapas.py` tiene el mapeo de los 57 códigos de mapa a su página del wiki.

## Mapas sin imagen

Tres capítulos no tienen miniatura en el wiki y usan el degradado de su campaña:
`c4m4_milltown_b` (Return to Town), `c5m5_bridge` (The Bridge, The Parish) y `c12m3_bridge`
(The Bridge, Blood Harvest). Los dos últimos comparten nombre con otros mapas y el wiki no los
desambigua.

## Derechos

El material gráfico de Left 4 Dead 2 pertenece a Valve. Se usa en un proyecto comunitario sin
ánimo de lucro cuya función es conectar a servidores del propio juego.
