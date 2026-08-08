#!/usr/bin/env python3
"""Descarga las miniaturas de mapa de L4D2 desde el wiki de Left 4 Dead.

Para cada capítulo busca TODAS las imágenes de su página, descarta el ruido
(logros, iconos, logos) y se queda con la captura más grande, dando prioridad a
las que mencionan el código del mapa en el nombre del archivo.

Se usa la API de MediaWiki, que es la interfaz pública del wiki; el HTML está
detrás de un desafío de Cloudflare.
"""
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

from PIL import Image

UA = "l4d2-summon/1.0 (proyecto comunitario; +https://github.com/Ventrax-01/l4d2-summon)"
API = "https://left4dead.fandom.com/api.php"
DEST = "/home/ventrax/modules/personal/l4d2-summon/web/public/mapas"

# código del mapa -> título del capítulo en el wiki
MAPAS = {
    # Dead Center
    "c1m1_hotel": "The Hotel", "c1m2_streets": "The Streets",
    "c1m3_mall": "The Mall", "c1m4_atrium": "The Atrium",
    # Dark Carnival
    "c2m1_highway": "The Highway", "c2m2_fairgrounds": "The Fairgrounds",
    "c2m3_coaster": "The Coaster", "c2m4_barns": "The Barns",
    "c2m5_concert": "The Concert",
    # Swamp Fever
    "c3m1_plankcountry": "Plank Country", "c3m2_swamp": "The Swamp",
    "c3m3_shantytown": "Shanty Town", "c3m4_plantation": "The Plantation",
    # Hard Rain
    "c4m1_milltown_a": "The Milltown", "c4m2_sugarmill_a": "The Sugar Mill",
    "c4m3_sugarmill_b": "Mill Escape", "c4m4_milltown_b": "Return to Town",
    "c4m5_milltown_escape": "Town Escape",
    # The Parish
    "c5m1_waterfront": "The Waterfront", "c5m2_park": "The Park",
    "c5m3_cemetery": "The Cemetery", "c5m4_quarter": "The Quarter",
    "c5m5_bridge": "The Bridge (The Parish)",
    # The Passing
    "c6m1_riverbank": "The Riverbank", "c6m2_bedlam": "The Underground",
    "c6m3_port": "The Port",
    # The Sacrifice
    "c7m1_docks": "The Docks", "c7m2_barge": "The Barge",
    "c7m3_port": "The Port (The Sacrifice)",
    # No Mercy
    "c8m1_apartment": "The Apartments", "c8m2_subway": "The Subway",
    "c8m3_sewers": "The Sewer", "c8m4_interior": "The Hospital",
    "c8m5_rooftop": "Rooftop Finale",
    # Crash Course
    "c9m1_alleys": "The Alleys", "c9m2_lots": "The Truck Depot Finale",
    # Death Toll
    "c10m1_caves": "The Turnpike", "c10m2_drainage": "The Drains",
    "c10m3_ranchhouse": "The Church", "c10m4_mainstreet": "The Town",
    "c10m5_houseboat": "Boathouse Finale",
    # Dead Air
    "c11m1_greenhouse": "The Greenhouse", "c11m2_offices": "The Crane",
    "c11m3_garage": "The Construction Site", "c11m4_terminal": "The Terminal",
    "c11m5_runway": "Runway Finale",
    # Blood Harvest
    "c12m1_hilltop": "The Woods", "c12m2_traintunnel": "The Tunnel",
    "c12m3_bridge": "The Bridge (Blood Harvest)", "c12m4_barn": "The Train Station",
    "c12m5_cornfield": "Farmhouse Finale",
    # Cold Stream
    "c13m1_alpinecreek": "Alpine Creek", "c13m2_southpinestream": "South Pine Stream",
    "c13m3_memorialbridge": "Memorial Bridge", "c13m4_cutthroatcreek": "Cut-throat Creek",
    # The Last Stand
    "c14m1_junkyard": "The Junkyard", "c14m2_lighthouse": "The Lighthouse",
}

RUIDO = re.compile(r"achievement|icon|logo|random.?map|\.svg|wiki|badge|spray|poster", re.I)
ANCHO_MIN = 640
ANCHO_SALIDA = 680  # el doble del ancho de la tarjeta, para pantallas densas


def pedir(url):
    r = subprocess.run(["curl", "-sSL", "-A", UA, url], capture_output=True)
    return r.stdout


def buscar_titulo(consulta):
    """Si el título exacto no existe, busca la página más parecida."""
    u = (f"{API}?action=query&list=search&srsearch={urllib.parse.quote(consulta)}"
         "&srlimit=1&format=json")
    try:
        j = json.loads(pedir(u) or "{}")
        hits = j.get("query", {}).get("search", [])
        return hits[0]["title"] if hits else None
    except Exception:
        return None


def candidatas(titulo):
    u = (f"{API}?action=query&generator=images&titles={urllib.parse.quote(titulo)}"
         "&gimlimit=80&prop=imageinfo&iiprop=url|size&format=json")
    try:
        j = json.loads(pedir(u) or "{}")
    except Exception:
        return []
    out = []
    for _, p in j.get("query", {}).get("pages", {}).items():
        t = p.get("title", "").replace("File:", "")
        ii = (p.get("imageinfo") or [{}])[0]
        w, h, url = ii.get("width", 0), ii.get("height", 0), ii.get("url")
        if not url or RUIDO.search(t) or w < ANCHO_MIN:
            continue
        out.append({"t": t, "w": w, "h": h, "url": url})
    return out


def elegir(cands, code):
    """El nombre del archivo que menciona el código del mapa es la mejor pista."""
    raiz = code.split("_")[0]                       # c1m1
    tema = code.split("_", 1)[1].split("_")[0]      # hotel
    def puntua(c):
        n = c["t"].lower().replace(" ", "").replace("_", "")
        return ((raiz in n) * 100_000
                + (tema[:5] in n) * 40_000
                + min(c["w"] * c["h"] // 1000, 30_000))
    return max(cands, key=puntua)


def procesar(raw, destino):
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    nh = int(w / 3)                      # proporción de la franja de la tarjeta
    if nh < h:
        top = int((h - nh) * 0.42)       # algo por encima del centro: el horizonte cae mejor
        im = im.crop((0, top, w, top + nh))
    im = im.resize((ANCHO_SALIDA, int(ANCHO_SALIDA * im.size[1] / im.size[0])), Image.LANCZOS)
    im.save(destino, "WEBP", quality=84, method=6)
    return im.size


def main():
    os.makedirs(DEST, exist_ok=True)
    ok, fallos = [], []
    for i, (code, titulo) in enumerate(MAPAS.items(), 1):
        cands = candidatas(titulo)
        usado = titulo
        if not cands:                                  # título distinto en el wiki
            alt = buscar_titulo(f"{titulo} Left 4 Dead 2")
            if alt:
                cands, usado = candidatas(alt), alt
        if not cands:
            fallos.append((code, titulo, "sin capturas"))
            print(f"  ✗ {code:<24} {titulo}", flush=True)
            continue
        mejor = elegir(cands, code)
        try:
            tam = procesar(pedir(mejor["url"]), os.path.join(DEST, f"{code}.webp"))
        except Exception as e:
            fallos.append((code, titulo, str(e)[:40]))
            print(f"  ✗ {code:<24} error: {e}", flush=True)
            continue
        kb = os.path.getsize(os.path.join(DEST, f"{code}.webp")) // 1024
        ok.append(code)
        print(f"  ✓ {code:<24} {mejor['w']}x{mejor['h']} → {kb:>3} KB  [{usado[:26]}]", flush=True)
        time.sleep(0.4)                                # cortesía con el wiki

    print(f"\n  RESUMEN: {len(ok)} descargados, {len(fallos)} fallidos, de {len(MAPAS)} mapas")
    if fallos:
        print("  Fallidos (hay que revisar el título):")
        for c, t, m in fallos:
            print(f"    {c:<24} '{t}'  → {m}")
    return 0 if not fallos else 1


if __name__ == "__main__":
    sys.exit(main())
