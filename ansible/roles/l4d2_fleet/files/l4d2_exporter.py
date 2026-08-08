#!/usr/bin/env python3
"""Prometheus exporter for a fleet of L4D2 (Source engine) servers.

Exposes, per instance (labelled by ``instance`` and ``port``):

    l4d2_up                 1 if the server answered A2S, else 0 (blips on map change)
    l4d2_service_up         1 if the systemd unit is active (stable across map changes)
    l4d2_players            current player count
    l4d2_max_players        slot count
    l4d2_bots               bot count
    l4d2_map_info{map}      1 (carries the current map as a label)
    l4d2_memory_bytes       resident memory of the server   (systemd MemoryCurrent)
    l4d2_cpu_seconds_total  cumulative CPU time of the server (systemd CPUUsageNSec)

Player/map data comes from Steam's A2S protocol; per-server CPU/RAM from systemd's
own per-unit accounting (no extra exporter needed). Configured from the environment
(see fleet.env): PORT_BASE, SERVER_COUNT, GAME_IP, EXPORTER_PORT.
"""
import http.server
import os
import socket
import subprocess


def primary_ip() -> str:
    """Best-effort detection of the host's primary outbound IPv4 address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


GAME_IP = os.environ.get("GAME_IP") or primary_ip()
PORT_BASE = int(os.environ.get("PORT_BASE", "6032"))
SERVER_COUNT = int(os.environ.get("SERVER_COUNT", "4"))
LISTEN_PORT = int(os.environ.get("EXPORTER_PORT", "9101"))
SERVERS = {n: PORT_BASE + n for n in range(1, SERVER_COUNT + 1)}

A2S_INFO = b"\xFF\xFF\xFF\xFF\x54Source Engine Query\x00"


def query(port: int) -> dict:
    """Server info for a single instance via A2S, or {'up': 0} if unreachable."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2)
    try:
        s.sendto(A2S_INFO, (GAME_IP, port))
        data, _ = s.recvfrom(4096)
        if data[4:5] == b"\x41":  # challenge — resend with the token
            s.sendto(A2S_INFO + data[5:9], (GAME_IP, port))
            data, _ = s.recvfrom(4096)
        if data[4:5] == b"\x49":  # S2A_INFO
            rest = data[6:]

            def read_str(buf):
                i = buf.index(0)
                return buf[:i].decode("utf-8", "replace"), buf[i + 1:]

            _name, rest = read_str(rest)
            mapn, rest = read_str(rest)
            _folder, rest = read_str(rest)
            _game, rest = read_str(rest)
            return {"up": 1, "players": rest[2], "max": rest[3], "bots": rest[4], "map": mapn}
    except Exception:
        pass
    finally:
        s.close()
    return {"up": 0}


def systemd_stats(inst: int):
    """(memory_bytes, cpu_seconds, service_up) for l4d2@<inst>.service from systemd.

    service_up reflects the unit's ActiveState (1 = active), so it stays up across
    map changes — unlike the A2S `l4d2_up`, which blips while srcds reloads a map.
    """
    try:
        # systemctl emits properties in its own order (not the -p order), so parse
        # by key rather than position.
        out = subprocess.run(
            ["/usr/bin/systemctl", "show", "l4d2@%d.service" % inst,
             "-p", "MemoryCurrent", "-p", "CPUUsageNSec", "-p", "ActiveState"],
            capture_output=True, text=True, timeout=3,
        ).stdout
        d = {}
        for line in out.splitlines():
            k, _, v = line.partition("=")
            d[k] = v
        mem = int(d["MemoryCurrent"]) if d.get("MemoryCurrent", "").isdigit() else 0
        cpu = int(d["CPUUsageNSec"]) / 1e9 if d.get("CPUUsageNSec", "").isdigit() else 0.0
        active = 1 if d.get("ActiveState") == "active" else 0
        return mem, cpu, active
    except Exception:
        return 0, 0.0, 0


class MetricsHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        up, players, maxp, bots, infos, mem, cpu, svc = [], [], [], [], [], [], [], []
        for inst, port in sorted(SERVERS.items()):
            lbl = 'instance="%d",port="%d"' % (inst, port)
            m = query(port)
            up.append("l4d2_up{%s} %d" % (lbl, m["up"]))
            if m["up"]:
                players.append("l4d2_players{%s} %d" % (lbl, m["players"]))
                maxp.append("l4d2_max_players{%s} %d" % (lbl, m["max"]))
                bots.append("l4d2_bots{%s} %d" % (lbl, m["bots"]))
                safe_map = m["map"].replace("\\", "").replace('"', "")
                infos.append('l4d2_map_info{%s,map="%s"} 1' % (lbl, safe_map))
            mbytes, cpusecs, active = systemd_stats(inst)
            mem.append("l4d2_memory_bytes{%s} %d" % (lbl, mbytes))
            cpu.append("l4d2_cpu_seconds_total{%s} %.3f" % (lbl, cpusecs))
            svc.append("l4d2_service_up{%s} %d" % (lbl, active))
        body = "\n".join(
            ["# TYPE l4d2_up gauge"] + up
            + ["# TYPE l4d2_service_up gauge"] + svc
            + ["# TYPE l4d2_players gauge"] + players
            + ["# TYPE l4d2_max_players gauge"] + maxp
            + ["# TYPE l4d2_bots gauge"] + bots
            + infos
            + ["# TYPE l4d2_memory_bytes gauge"] + mem
            + ["# TYPE l4d2_cpu_seconds_total counter"] + cpu
        ) + "\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    http.server.HTTPServer(("127.0.0.1", LISTEN_PORT), MetricsHandler).serve_forever()
