#!/usr/bin/env python3
"""work-dash 앱 아이콘(1024x1024 PNG)을 그린다. 외부 라이브러리 없이 표준 라이브러리만 쓴다.

모양: macOS 앱 아이콘 규격(1024 캔버스 안 824px 몸체, 둥근 사각형) + 진행률 막대 3개.
막대 색은 화면과 같은 뜻으로 쓴다: 완료 진행률 파랑 · 진행 중 보라 · 진행 가능 초록.

    python3 desktop/scripts/make-icon.py          # desktop/icons/app-icon.png 생성
    npx tauri icon desktop/icons/app-icon.png -o desktop/icons   # 크기별 아이콘 · icns 생성

경계는 부호 거리(signed distance)로 1px 안에서 부드럽게 칠해 계단 현상을 없앤다.
"""
import math
import os
import struct
import zlib

S = 1024
BODY = 824                      # 몸체 크기 (Apple 템플릿: 1024 캔버스, 100px 여백)
M = (S - BODY) / 2
N = 5.0                         # 초타원 지수: 4~5면 macOS의 부드러운 둥근 사각형에 가깝다

TOP = (0x2E, 0x35, 0x58)        # 몸체 위쪽 색
BOTTOM = (0x14, 0x17, 0x26)     # 몸체 아래쪽 색
TRACK = (255, 255, 255, 0.13)   # 막대 바탕
BARS = [                        # (채움 비율, 색)
    (0.84, (0x6D, 0x97, 0xFF)),
    (0.58, (0xB8, 0x9C, 0xFF)),
    (0.34, (0x4C, 0xC6, 0x84)),
]
BAR_X0, BAR_X1 = 232, 792
BAR_H = 84
BAR_YS = [370, 512, 654]        # 막대 중심


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def body_dist(x, y, dy=0.0):
    """초타원 몸체까지의 대략적인 거리(px). 안쪽이 음수."""
    a = BODY / 2
    cx, cy = S / 2, S / 2 + dy
    u, v = abs(x - cx) / a, abs(y - cy) / a
    r = (u ** N + v ** N) ** (1 / N)
    return (r - 1) * a


def pill_dist(x, y, x0, x1, cy, h):
    """알약 모양(양끝이 반원인 막대)까지의 거리. 안쪽이 음수."""
    r = h / 2
    px = clamp(x, x0 + r, x1 - r) if x1 - x0 > h else (x0 + x1) / 2
    return math.hypot(x - px, y - cy) - r


def over(dst, rgb, a):
    """dst(r,g,b,a 0~1) 위에 색 rgb를 불투명도 a로 덮는다."""
    if a <= 0:
        return dst
    r, g, b, da = dst
    oa = a + da * (1 - a)
    if oa <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    f = lambda s, d: (s / 255 * a + d * da * (1 - a)) / oa
    return (f(rgb[0], r), f(rgb[1], g), f(rgb[2], b), oa)


def pixel(x, y):
    px, py = x + 0.5, y + 0.5
    c = (0.0, 0.0, 0.0, 0.0)
    # 그림자: 몸체를 아래로 14px 옮긴 모양에서 바깥으로 36px 동안 옅어진다
    sd = body_dist(px, py, dy=14)
    if sd < 36:
        c = over(c, (0, 0, 0), 0.32 * (1 - clamp(sd / 36)) ** 2)
    d = body_dist(px, py)
    cover = clamp(0.5 - d)
    if cover <= 0:
        return c
    t = clamp((py - M) / BODY)
    bg = tuple(TOP[i] + (BOTTOM[i] - TOP[i]) * t for i in range(3))
    c = over(c, bg, cover)
    # 위쪽 가장자리의 은은한 빛
    if d > -6:
        c = over(c, (255, 255, 255), 0.10 * cover * clamp((d + 6) / 6) * (1 - t))
    for (frac, color), cy in zip(BARS, BAR_YS):
        if abs(py - cy) > BAR_H:
            continue
        tr = clamp(0.5 - pill_dist(px, py, BAR_X0, BAR_X1, cy, BAR_H))
        if tr > 0:
            c = over(c, TRACK[:3], TRACK[3] * tr * cover)
        fill_x1 = BAR_X0 + (BAR_X1 - BAR_X0) * frac
        fr = clamp(0.5 - pill_dist(px, py, BAR_X0, fill_x1, cy, BAR_H))
        if fr > 0:
            c = over(c, color, fr * cover)
    return c


def main():
    rows = []
    for y in range(S):
        row = bytearray(b"\x00")
        for x in range(S):
            r, g, b, a = pixel(x, y)
            row += bytes((round(r * 255), round(g * 255), round(b * 255), round(a * 255)))
        rows.append(bytes(row))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons", "app-icon.png")
    with open(out, "wb") as f:
        f.write(png)
    print(os.path.normpath(out))


if __name__ == "__main__":
    main()
