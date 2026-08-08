# Miniaturas de mapa

Una por capítulo de Left 4 Dead 2, nombrada con el código del mapa que reporta el servidor
(`c1m1_hotel.webp`). **Añadir o reemplazar un mapa es dejar aquí su `.webp`**: no hay que tocar
código. Si falta el archivo, la tarjeta cae al degradado de la campaña y no se rompe.

## Qué imágenes son

Son las **miniaturas oficiales que el propio juego usa** en su selector de mapas: 256×128, y ahora
salen **directamente de los archivos del juego**, no del wiki.

Están en los VPK como `materials/vgui/maps/<mapa>.vtf`, en DXT1 con mipmaps. Las extrae
`tools/extraer-mapas-del-juego.py`, que hay que ejecutar en una máquina con el juego instalado
(el servidor dedicado vale) y copiar el resultado aquí.

Antes se bajaban del wiki con `tools/descargar-mapas.py`. Se cambió porque aquellas venían
recomprimidas y con marcas del sitio encima: mismo tamaño, peor material. Estas son el original
de Valve sin intermediarios.

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

## Cobertura

**Los 57 capítulos de las 14 campañas oficiales tienen miniatura.**

Tres costaron encontrarlos porque el wiki desambigua los nombres repetidos de una forma que no
es evidente: el puente de The Parish es `The Bridge (Left 4 Dead 2)`, el de Blood Harvest es
`The Bridge (Left 4 Dead)`, y `Return To Town` lleva la T mayúscula.

Los **mapas personalizados** no tienen miniatura y caen al degradado de su campaña. Es lo
esperable: en comunidades competitivas se juegan mapas de la comunidad con frecuencia.

## Derechos

El material gráfico de Left 4 Dead 2 pertenece a Valve. Se usa en un proyecto comunitario sin
ánimo de lucro cuya función es conectar a servidores del propio juego.
