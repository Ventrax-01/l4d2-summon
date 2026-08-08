# Miniaturas de mapa

Una por capítulo de Left 4 Dead 2, nombradas con el código del mapa que reporta el servidor
(`c1m1_hotel.webp`). Añadir un mapa es dejar aquí su `.webp`: no hay que tocar código. Si falta
el archivo, la tarjeta cae al degradado de la campaña y no se rompe.

## De dónde salen

Son capturas del juego publicadas en el wiki de Left 4 Dead, obtenidas mediante su **API de
MediaWiki** (el HTML del wiki está tras un desafío de Cloudflare; la API es la interfaz pública
y es la vía correcta).

El script `tools/descargar-mapas.py` las regenera: pide todas las imágenes de la página de cada
capítulo con su tamaño real, descarta el ruido (logros, iconos, logos), y puntúa las candidatas
dando prioridad a las que mencionan el código del mapa en el nombre del archivo. Después recorta
la franja central a 3:1, escala a 680px de ancho —el doble del tamaño de la tarjeta, para
pantallas densas— y guarda en WebP. Rondan los 15 KB cada una.

**Importante:** se parte de capturas grandes (1440×900 y similares) y se REDUCE. La imagen del
infobox de cada página es la miniatura de 256×128 que trae el juego; ampliarla daba resultados
borrosos.

Se sirven desde nuestro propio CDN, nunca enlazadas al wiki: enlazar de fuera usa ancho de banda
ajeno, las URLs llevan un hash de revisión que cambia, y rompería la política de seguridad del
sitio.

## Mapas sin imagen

Siete capítulos no tienen captura utilizable en el wiki y usan el degradado de su campaña:
`c4m4_milltown_b`, `c5m5_bridge`, `c12m3_bridge`, `c13m1_alpinecreek`, `c13m2_southpinestream`,
`c13m4_cutthroatcreek`, `c14m1_junkyard`.

Se descartaron a propósito dos que sí se habían descargado: una era una miniatura de vídeo de
480px y la otra mostraba un mapa de otra campaña. **Enseñar el mapa equivocado es peor que no
enseñar ninguno.**

## Derechos

El material gráfico de Left 4 Dead 2 pertenece a Valve. Se usa en un proyecto comunitario sin
ánimo de lucro cuya función es conectar a servidores del propio juego.
