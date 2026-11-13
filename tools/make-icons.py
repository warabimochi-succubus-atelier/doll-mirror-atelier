"""アプリアイコンの書き出し（標準ライブラリのみ。Pillow などは不要）

使い方: python tools/make-icons.py

原画 icons/source/icon-original.png（RGB・8bit・インターレースなしの PNG）から、
仕様書「アプリアイコン」の各サイズを icons/ に書き出す。

原画には角丸と外周の余白が含まれているため、角丸の外側（白い部分）が入らない範囲を
正方形に切り出してから縮小する（OS 側でも角丸マスクがかかるため、全面に絵がある正方形にする）。
maskable は重要な要素を中央 80% に収めるため、切り出した絵を 80% に縮めて周囲を背景色で埋める。
"""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'icons' / 'source' / 'icon-original.png'
OUT = ROOT / 'icons'

# 原画 1254px のうち、角丸の外側が入らない内側の範囲（外周の余白 約20px ＋ 角丸の半径 約140px から求めた値）
CROP_MARGIN_RATIO = 72 / 1254
# maskable の周囲を埋める色（原画の背景に近い淡いピンク）
MASK_BG = (243, 226, 232)


def read_png(path):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'PNG ではありません'
    pos, idat, w = 8, b'', 0
    while pos < len(data):
        n, typ = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if typ == b'IHDR':
            w, h, depth, ctype, _, _, inter = struct.unpack('>IIBBBBB', body)
            assert depth == 8 and ctype in (2, 6) and inter == 0, '8bit の RGB / RGBA・インターレースなしの PNG のみ対応'
            bpp = 3 if ctype == 2 else 4
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        pos += 12 + n
    raw = zlib.decompress(idat)
    stride = w * bpp
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line); prev = line
    # RGB にそろえる
    if bpp == 4:
        rows = [bytearray(b for k in range(w) for b in r[k * 4:k * 4 + 3]) for r in rows]
    return w, h, rows


def write_png(path, size, rows):
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    def chunk(t, b):
        return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) \
        + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    path.write_bytes(png)
    return png


def resize_area(rows, x0, y0, side, size):
    """正方形の範囲 (x0, y0, side) を size×size に面積平均で縮小する"""
    out = []
    scale = side / size
    for oy in range(size):
        sy0, sy1 = y0 + oy * scale, y0 + (oy + 1) * scale
        line = bytearray(size * 3)
        for ox in range(size):
            sx0, sx1 = x0 + ox * scale, x0 + (ox + 1) * scale
            acc = [0.0, 0.0, 0.0]; wsum = 0.0
            y = int(sy0)
            while y < sy1:
                wy = min(sy1, y + 1) - max(sy0, y)
                r = rows[y]
                x = int(sx0)
                while x < sx1:
                    wx = min(sx1, x + 1) - max(sx0, x)
                    wgt = wx * wy; k = x * 3
                    acc[0] += r[k] * wgt; acc[1] += r[k + 1] * wgt; acc[2] += r[k + 2] * wgt
                    wsum += wgt
                    x += 1
                y += 1
            for c in range(3):
                line[ox * 3 + c] = min(255, int(acc[c] / wsum + 0.5))
        out.append(line)
    return out


def pad_maskable(rows, size):
    inner = len(rows)
    off = (size - inner) // 2
    out = []
    for y in range(size):
        line = bytearray(bytes(MASK_BG) * size)
        if off <= y < off + inner:
            line[off * 3:(off + inner) * 3] = rows[y - off]
        out.append(line)
    return out


def main():
    w, h, rows = read_png(SRC)
    side0 = min(w, h)
    m = round(side0 * CROP_MARGIN_RATIO)
    x0, y0, side = (w - side0) // 2 + m, (h - side0) // 2 + m, side0 - 2 * m
    print(f'原画 {w}x{h} → 切り出し {side}px（外周 {m}px を除く）')
    pngs = {}
    for name, size in [('icon-512.png', 512), ('icon-192.png', 192), ('apple-touch-icon.png', 180),
                       ('favicon-32.png', 32), ('favicon-16.png', 16)]:
        pngs[name] = write_png(OUT / name, size, resize_area(rows, x0, y0, side, size))
        print(f'  {name}')
    for name, size in [('icon-maskable-512.png', 512), ('icon-maskable-192.png', 192)]:
        inner = round(size * 0.8)
        write_png(OUT / name, size, pad_maskable(resize_area(rows, x0, y0, side, inner), size))
        print(f'  {name}')
    # favicon.ico（16px と 32px の PNG をそのまま格納する）
    imgs = [(16, pngs['favicon-16.png']), (32, pngs['favicon-32.png'])]
    head = struct.pack('<HHH', 0, 1, len(imgs))
    offset = 6 + 16 * len(imgs)
    dirs, body = b'', b''
    for s, p in imgs:
        dirs += struct.pack('<BBBBHHII', s, s, 0, 0, 1, 32, len(p), offset + len(body))
        body += p
    (OUT / 'favicon.ico').write_bytes(head + dirs + body)
    (OUT / 'favicon-16.png').unlink()
    print('  favicon.ico')


if __name__ == '__main__':
    main()
