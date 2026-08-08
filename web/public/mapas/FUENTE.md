# Miniaturas de mapa

Son las imágenes que **el propio juego** usa en su selector de mapas (256×128 en los
archivos de Left 4 Dead 2), obtenidas mediante la API de MediaWiki del wiki de Left 4 Dead
y recortadas a la proporción de la tarjeta.

Proceso aplicado: recorte de la franja central a 3:1 → escalado a 680px de ancho (el doble
del tamaño de la tarjeta, para pantallas densas) → WebP calidad 82. Rondan los 10 KB cada una.

**Se sirven desde nuestro propio CDN, nunca enlazadas desde el wiki**: enlazar de fuera usa
ancho de banda ajeno, las URLs llevan un hash de revisión que cambia, y romperia la política
de seguridad del sitio.

El nombre del archivo es el código del mapa que reporta el servidor (`c1m1_hotel.webp`), así
que añadir un mapa es dejar su `.webp` aquí: no hay que tocar código.

Si falta el archivo de un mapa, la tarjeta muestra el degradado de la campaña y no se rompe.

## Derechos

El material gráfico de Left 4 Dead 2 pertenece a Valve. Se usa aquí en un proyecto
comunitario sin ánimo de lucro que sirve para conectarse a servidores del propio juego.
