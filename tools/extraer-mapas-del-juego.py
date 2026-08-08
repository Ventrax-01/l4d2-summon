#!/usr/bin/env python3
"""Saca las miniaturas de mapa de los archivos del propio L4D2 y las deja en WebP.

Sustituye a `descargar-mapas.py`, que las bajaba de la wiki. Las de la wiki venían
recomprimidas y con marcas del sitio; estas son el material original de Valve, del mismo
tamaño (256x128) pero sin pasar por ningún intermediario.

Hay que ejecutarlo en una máquina con el juego instalado —el servidor dedicado vale— y
copiar el resultado al repo:

    python3 extraer-mapas-del-juego.py /home/steam/l4d2 ./salida

Dos cosas del formato que conviene saber antes de tocar esto:

  · Un VTF guarda sus mipmaps de la MÁS PEQUEÑA a la más grande, así que la imagen a
    resolución completa son los ÚLTIMOS bytes del fichero, no los primeros.

  · La carga viene en DXT1/DXT5 comprimido. En vez de escribir un decodificador de bloques
    se le antepone una cabecera DDS y decodifica PIL, que ya lo trae hecho y probado.
"""
import io
import pathlib
import struct
import sys

from PIL import Image

# Orden de búsqueda del motor: `update` es el parche y pisa al paquete base; `_lv` es la
# variante de baja violencia y va al final. Quedarse con la primera aparición resuelve igual
# que el juego.
PAQUETES = [
    "update",
    "left4dead2_dlc3",
    "left4dead2_dlc2",
    "left4dead2_dlc1",
    "left4dead2",
    "left4dead2_lv",
]

# Las campañas de L4D1 portadas a L4D2 conservan para su miniatura el nombre interno que
# tenían en L4D1, aunque el mapa se llame c7*/c8*. No hay regla que lo derive: es una tabla.
ALIAS = {
    "c7m1_docks": "l4d_river01_docks",
    "c7m2_barge": "l4d_river02_barge",
    "c7m3_port": "l4d_river03_port",
    "c8m1_apartment": "l4d_hospital01_apartment",
    "c8m2_subway": "l4d_hospital02_subway",
    "c8m3_sewers": "l4d_hospital03_sewers",
    "c8m4_interior": "l4d_hospital04_interior",
    "c8m5_rooftop": "l4d_hospital05_rooftop",
}

FORMATOS = {13: ("DXT1", 8), 14: ("DXT3", 16), 15: ("DXT5", 16)}
CALIDAD_WEBP = 92


def _cadena(f) -> str:
    b = bytearray()
    while True:
        c = f.read(1)
        if not c or c == b"\x00":
            return b.decode("utf-8", "replace")
        b += c


def indice_vpk(vpk_dir: pathlib.Path, carpeta_buscada: str, extension: str) -> dict:
    """{nombre: (archivo, offset, largo, precarga)} de las entradas que interesan."""
    entradas = {}
    with open(vpk_dir, "rb") as f:
        firma, version = struct.unpack("<II", f.read(8))
        if firma != 0x55AA1234:
            return entradas
        largo_arbol = struct.unpack("<I", f.read(4))[0]
        if version == 2:
            f.read(16)
        while True:
            ext = _cadena(f)
            if not ext:
                break
            while True:
                carpeta = _cadena(f)
                if not carpeta:
                    break
                while True:
                    nombre = _cadena(f)
                    if not nombre:
                        break
                    _crc, pre, idx, off, largo, _term = struct.unpack("<IHHIIH", f.read(18))
                    datos_pre = f.read(pre) if pre else b""
                    if ext == extension and carpeta == carpeta_buscada:
                        entradas[nombre] = (idx, off, largo, datos_pre, largo_arbol)
    return entradas


def leer_entrada(vpk_dir: pathlib.Path, entrada) -> bytes:
    idx, off, largo, pre, largo_arbol = entrada
    if idx == 0x7FFF:  # los datos van en el propio _dir
        with open(vpk_dir, "rb") as f:
            f.seek(12 + largo_arbol + off)
            return pre + f.read(largo)
    base = str(vpk_dir)[: -len("_dir.vpk")]
    with open(f"{base}_{idx:03d}.vpk", "rb") as f:
        f.seek(off)
        return pre + f.read(largo)


def _cabecera_dds(ancho: int, alto: int, fourcc: bytes) -> bytes:
    por_bloque = 8 if fourcc == b"DXT1" else 16
    return (
        b"DDS "
        + struct.pack("<I", 124)
        + struct.pack("<I", 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000)
        + struct.pack("<II", alto, ancho)
        + struct.pack("<I", max(1, ancho // 4) * max(1, alto // 4) * por_bloque)
        + struct.pack("<I", 0)
        + struct.pack("<I", 1)
        + b"\x00" * 44
        + struct.pack("<I", 32)
        + struct.pack("<I", 0x4)
        + fourcc
        + b"\x00" * 20
        + struct.pack("<I", 0x1000)
        + b"\x00" * 16
    )


def vtf_a_imagen(datos: bytes):
    if datos[:4] != b"VTF\x00":
        return None
    ancho, alto = struct.unpack("<HH", datos[16:20])
    formato = struct.unpack("<I", datos[52:56])[0]
    if formato not in FORMATOS:
        return None
    nombre, por_bloque = FORMATOS[formato]
    tam = max(1, ancho // 4) * max(1, alto // 4) * por_bloque
    if tam > len(datos):
        return None
    cabecera = _cabecera_dds(ancho, alto, nombre.encode())
    imagen = Image.open(io.BytesIO(cabecera + datos[-tam:]))  # la última mip es la grande
    return imagen.convert("RGB"), ancho, alto, nombre


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    raiz, salida = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    salida.mkdir(parents=True, exist_ok=True)

    # Se recorren los paquetes en orden de prioridad y solo se toma la primera aparición.
    catalogo = {}
    for paquete in PAQUETES:
        for vpk_dir in sorted((raiz / paquete).glob("*_dir.vpk")):
            for nombre, entrada in indice_vpk(vpk_dir, "materials/vgui/maps", "vtf").items():
                catalogo.setdefault(nombre, (vpk_dir, entrada))

    if not catalogo:
        print(f"no se encontró ninguna miniatura bajo {raiz}; ¿es la raíz del juego?")
        return 1

    hechos, fallos = 0, []
    for mapa in sorted(set(catalogo) | set(ALIAS)):
        interno = ALIAS.get(mapa, mapa)
        if interno not in catalogo:
            continue
        vpk_dir, entrada = catalogo[interno]
        r = vtf_a_imagen(leer_entrada(vpk_dir, entrada))
        if r is None:
            fallos.append(mapa)
            continue
        imagen, ancho, alto, _fmt = r
        imagen.save(salida / f"{mapa}.webp", "WEBP", quality=CALIDAD_WEBP, method=6)
        hechos += 1

    print(f"{hechos} miniaturas escritas en {salida}")
    if fallos:
        print(f"sin convertir: {', '.join(fallos)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
