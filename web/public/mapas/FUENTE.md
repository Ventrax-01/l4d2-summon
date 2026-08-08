# Miniaturas de mapa

Una por capítulo de Left 4 Dead 2, nombrada con el código del mapa que reporta el servidor
(`c1m1_hotel.webp`). **Añadir o reemplazar un mapa es dejar aquí su `.webp`**: no hay que tocar
código. Si falta el archivo, la tarjeta cae al degradado de la campaña y no se rompe.

## Qué imágenes son

Son las **miniaturas oficiales que el propio juego usa** en su selector de mapas, y salen
**directamente de los archivos del juego**, no del wiki. Dentro del juego miden 256×128; aquí se
guardan ampliadas a 768×384, como se explica más abajo.

Están en los VPK como `materials/vgui/maps/<mapa>.vtf`, en DXT1 con mipmaps. Las extrae
`tools/extraer-mapas-del-juego.py`, que hay que ejecutar en una máquina con el juego instalado
(el servidor dedicado vale) y copiar el resultado aquí.

Antes se bajaban del wiki con `tools/descargar-mapas.py`. Se cambió porque aquellas venían
recomprimidas y con marcas del sitio encima: mismo tamaño, peor material. Estas son el original
de Valve sin intermediarios.

Se eligieron frente a las capturas de jugadores que también hay en el wiki —bastante más grandes,
hasta 1440×900— por **consistencia**: las oficiales son todas del mismo estilo y encuadre,
mientras que las capturas varían mucho entre sí y algunas ni siquiera corresponden al mapa.

**No se recortan ni se les cambia el encuadre.** De eso se encarga el CSS de la tarjeta
(`background-size: cover` centrado), así que sustituir una imagen por otra de distinta resolución
funciona sin cambiar nada más.

## Están ampliadas por IA

256×128 es el tamaño nativo: no existe una versión mayor dentro del juego. Pero la tarjeta las
pinta a 288 px de ancho en escritorio y 370 en móvil, así que ya se ampliaban incluso a 1×, y en
pantallas retina harían falta 576 px como mínimo. Por eso se guardan **ampliadas a 768×384**: 3×
exacto, misma proporción 2:1.

La ampliación se hizo con [Upscayl](https://github.com/upscayl/upscayl) y el modelo
`ultramix-balanced-4x`, ampliando a 1024×512 y reduciendo después a 768×384 con Lanczos —sale
entre un 25 % y un 38 % más nítido que pedirle un 3× directo—, con salida WebP de calidad 85.

Ese modelo se eligió entre los siete que trae Upscayl porque es el único que aguanta a la vez las
tres cosas que hay en estas capturas —rótulos, geometría fina y niebla volumétrica— sin desviar el
tono: su desviación de luminancia media es de +0,20 niveles sobre 255.

Conviene tenerlo presente: un modelo de superresolución **reconstruye** detalle, no lo recupera.
En `c1m3_mall` el cartel «GRAND RE-OPENING» gana bordes nítidos pero sigue sin poder leerse, y en
`c10m1_caves` aparece algo de grano en las sombras. A tamaño de tarjeta ninguna de las dos cosas
se nota.

Se sirven desde nuestro propio CDN, nunca enlazadas al wiki: enlazar de fuera usa ancho de banda
ajeno, las URLs llevan un hash de revisión que cambia, y rompería la política de seguridad del
sitio.

## Regenerar

Son dos pasos, y el segundo es fácil de olvidar:

1. `tools/extraer-mapas-del-juego.py` saca los `.vtf` de los VPK y los deja en WebP de 256×128.
   Hay que ejecutarlo en una máquina con el juego instalado.
2. Ampliar cada uno a 768×384 con Upscayl, según lo descrito arriba. **Si te saltas este paso las
   miniaturas vuelven a verse blandas**; la web sigue funcionando, pero pierdes la mejora.

`tools/descargar-mapas.py` se conserva con el mapeo de los 57 códigos a su página del wiki, por si
alguna vez hace falta volver a esa vía.

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
