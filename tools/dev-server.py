"""開発用のサーバー（python -m http.server の代わり）

使い方: python tools/dev-server.py [ポート番号] [--lan]   （ポートの既定は 8766）

python -m http.server はキャッシュの指示（Cache-Control）を送らないため、
ブラウザが「しばらく変わらないだろう」と推測してファイルをキャッシュから読み、
変更が反映されないことがある。特に iPhone から LAN のアドレス（http://192.168.x.x:8766 など）で
開くと、http では Service Worker も動かないため、再読み込みしても古いファイルのままになりやすい。
このサーバーはすべての応答に Cache-Control: no-cache を付け、毎回サーバーに確かめさせる
（変わっていないファイルは 304 で返すので軽い）。

どこから起動しても、このリポジトリのルートを配信する。開発用なので、公開のサーバーには使わない。

安全のため:
- 既定では、この PC（127.0.0.1）からだけ開ける。同じ Wi-Fi の端末から開くときだけ --lan を付ける
  （カフェなどの共有の Wi-Fi では付けない）
- . で始まるファイル・フォルダー（.git、.claude 等）は配信しない
- フォルダーの中身の一覧は表示しない（index.html があるフォルダーはそれを返す）
"""
import argparse
import socket
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_head(self):
        # . で始まる部分を含むパスは、無いものとして扱う（%2e のような書き方も、戻してから調べる）
        parts = unquote(urlsplit(self.path).path).replace('\\', '/').split('/')
        if any(p.startswith('.') for p in parts if p):
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)
        return None


def lan_address():
    # 外へ出るときに使う自分の IP アドレス（実際には送信しない）。分からなければ None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('192.0.2.1', 9))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    sys.stdout.reconfigure(line_buffering=True)  # 起動の案内をすぐ表示する（出力をファイルなどに流したときも）
    ap = argparse.ArgumentParser(description='開発用のサーバー（キャッシュさせずに配信する）')
    ap.add_argument('port', nargs='?', type=int, default=8766, help='ポート番号（既定は 8766）')
    ap.add_argument('--lan', action='store_true', help='同じ Wi-Fi の端末からも開けるようにする')
    args = ap.parse_args()
    host = '' if args.lan else '127.0.0.1'
    handler = partial(NoCacheHandler, directory=str(ROOT))
    with ThreadingHTTPServer((host, args.port), handler) as httpd:
        print(f'配信中: {ROOT}')
        print(f'  この PC:        http://localhost:{args.port}/')
        if args.lan:
            ip = lan_address()
            if ip:
                print(f'  同じ Wi-Fi から: http://{ip}:{args.port}/')
        else:
            print('  （同じ Wi-Fi の端末から開くときは --lan を付けて起動する）')
        print('止めるときは Ctrl+C')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
