#!/usr/bin/env python3
"""Erzeugt die Vorführmodelle für die Werbevideos (eigene Modelle, frei verwendbar)."""
import math, os, struct
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), "models")

def write_stl(path, tris):
    tris = np.asarray(tris, dtype=np.float32)
    with open(path, "wb") as f:
        f.write(b"Druckerwacht demo model".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for t in tris:
            n = np.cross(t[1] - t[0], t[2] - t[0]); l = np.linalg.norm(n)
            n = n / l if l else n
            f.write(struct.pack("<3f", *n)); f.write(t.astype("<f4").tobytes()); f.write(b"\0\0")

def loft(rings, cap_bottom=True, cap_top=True):
    """Ringe gleicher Punktzahl (gegen den Uhrzeigersinn) zu einer geschlossenen Hülle verbinden."""
    tris = []; n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            tris += [[a[i], a[j], b[j]], [a[i], b[j], b[i]]]
    for ring, top in ((rings[0], False), (rings[-1], True)):
        if (top and not cap_top) or (not top and not cap_bottom): continue
        c = ring.mean(axis=0)
        for i in range(n):
            j = (i + 1) % n
            tris.append([c, ring[i], ring[j]] if top else [c, ring[j], ring[i]])
    return tris

def vase():
    rings = []; H = 46; N = 120
    for k in range(47):
        z = H * k / 46; tw = math.radians(70) * k / 46
        r0 = 15 + 5 * math.sin(math.pi * k / 46 * 1.1) - 2 * (k / 46) ** 2
        pts = []
        for i in range(N):
            a = 2 * math.pi * i / N
            r = r0 * (1 + 0.13 * math.cos(6 * (a + tw)))
            pts.append([r * math.cos(a), r * math.sin(a), z])
        rings.append(np.array(pts))
    return loft(rings)

def gear():
    teeth = 16; R = 19; h = 6; pts = []; N = teeth * 16
    for i in range(N):
        a = 2 * math.pi * i / N; ph = (i % 16) / 16
        tooth = 1 if 0.25 < ph < 0.6 else (0 if ph < 0.15 or ph > 0.7 else 0.5)
        r = R - 3.2 + 6.4 * tooth
        pts.append([r * math.cos(a), r * math.sin(a)])
    outer = np.array(pts); tris = []
    hole = np.array([[8 * math.cos(2 * math.pi * i / N), 8 * math.sin(2 * math.pi * i / N)] for i in range(N)])
    for z0, z1 in ((0, h),):
        for i in range(N):
            j = (i + 1) % N
            o0, o1, i0, i1 = outer[i], outer[j], hole[i], hole[j]
            P = lambda p, z: [p[0], p[1], z]
            tris += [[P(o0, z0), P(o1, z0), P(o1, z1)], [P(o0, z0), P(o1, z1), P(o0, z1)]]      # außen
            tris += [[P(i0, z0), P(i1, z1), P(i1, z0)], [P(i0, z0), P(i0, z1), P(i1, z1)]]      # Loch
            tris += [[P(o0, z1), P(o1, z1), P(i1, z1)], [P(o0, z1), P(i1, z1), P(i0, z1)]]      # oben
            tris += [[P(o0, z0), P(i1, z0), P(o1, z0)], [P(o0, z0), P(i0, z0), P(i1, z0)]]      # unten
    return tris

def pot():
    # Facettierter Pflanztopf (Low-Poly), Ringe gegeneinander verdreht
    rings = []; N = 10
    for k, (z, r) in enumerate([(0, 12), (7, 16), (15, 18), (22, 19), (26, 20)]):
        off = (k % 2) * math.pi / N
        rings.append(np.array([[r * math.cos(2 * math.pi * i / N + off), r * math.sin(2 * math.pi * i / N + off), z] for i in range(N)]))
    return loft(rings)

os.makedirs(OUT, exist_ok=True)
write_stl(os.path.join(OUT, "Vase_gedreht.stl"), vase())
write_stl(os.path.join(OUT, "Zahnrad.stl"), gear())
write_stl(os.path.join(OUT, "Pflanztopf.stl"), pot())
print(sorted(os.listdir(OUT)))
