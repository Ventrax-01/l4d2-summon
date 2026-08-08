#!/usr/bin/env bash
# Despierta la máquina mandando el paquete mágico DESDE LA RED LOCAL.
#
# La plataforma lo hace sola desde AWS al reservar, pero eso depende de que el router sepa
# entregar el paquete con el equipo apagado — y sin un enlace fijo IP↔MAC deja de saberlo
# a los pocos minutos, cuando caduca su entrada ARP (ver ansible/README.md). Desde la LAN
# no hace falta nada de eso: se manda a la dirección de difusión y la tarjeta lo recoge.
set -euo pipefail

MAC="${1:-0A:E0:AF:AF:28:22}"
DIFUSION="${2:-255.255.255.255}"

python3 - "$MAC" "$DIFUSION" <<'PY'
import socket, sys
mac, difusion = sys.argv[1], sys.argv[2]
paquete = b"\xff" * 6 + bytes.fromhex(mac.replace(":", "").replace("-", "")) * 16
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
for puerto in (7, 9):          # los dos puertos que se usan por convención
    for _ in range(3):         # es UDP: no hay acuse de recibo
        s.sendto(paquete, (difusion, puerto))
s.close()
print(f"paquete mágico enviado a {mac} por difusión ({difusion})")
PY
