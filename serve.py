#!/usr/bin/env python3
"""NMEA 分析平台的本地服务器。

做两件事：

1. 提供静态文件（``/`` → ``web/index.html``，``/web/*``，``/nmea.log``）；
2. 代理地图瓦片 ``/tiles/{source}/{z}/{x}/{y}``，并缓存到 ``.cache/tiles``。

代理瓦片的原因：浏览器直连外部瓦片服务常被 CORS / 网络策略挡住，而且
ArcGIS 的 URL 是 ``{z}/{y}/{x}`` 顺序，Plotly 的 raster layer 只接受
``{z}/{x}/{y}``。代理同时解决这两个问题。

用法::

    python serve.py                # http://localhost:8000/
    python serve.py --port 9000 --open
"""

from __future__ import annotations

import argparse
import http.server
import mimetypes
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
CACHE_DIR = ROOT / ".cache" / "tiles"

# 名称 -> (URL 模板, 缓存扩展名)
TILE_SOURCES: dict[str, tuple[str, str]] = {
    # WGS84 / Web Mercator，与 GNSS 坐标一致，无需任何纠偏
    "arcgis-imagery": (
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ".jpg",
    ),
    # 高德使用 GCJ-02 坐标系，前端会先做 WGS84 -> GCJ-02 纠偏
    "gaode-street": (
        "https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
        ".png",
    ),
    "gaode-satellite": (
        "https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
        ".jpg",
    ),
    "osm": ("https://tile.openstreetmap.org/{z}/{x}/{y}.png", ".png"),
}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

_CACHE_LOCK = threading.Lock()


def sniff_image_type(data: bytes) -> str | None:
    """根据文件头判断图片类型；上游偶尔返回与扩展名不符的格式。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data.startswith(b"GIF8"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _guess_content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in CONTENT_TYPES:
        return CONTENT_TYPES[suffix]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "NMEAServer/1.0"
    protocol_version = "HTTP/1.1"

    # ---------------------------------------------------------------- #
    # 路由
    # ---------------------------------------------------------------- #
    def do_GET(self) -> None:  # noqa: N802 (http.server 约定)
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)

        if path in ("/", "/index.html"):
            self._serve_file(WEB_DIR / "index.html", cache=False)
            return
        if path.startswith("/tiles/"):
            self._serve_tile(path[len("/tiles/"):])
            return
        if path == "/nmea.log":
            self._serve_file(ROOT / "nmea.log", cache=False, root=ROOT)
            return

        # 其余路径按 web/ 目录解析：既支持 /app.js，也支持 /web/app.js
        relative = path.lstrip("/")
        if relative.startswith("web/"):
            relative = relative[len("web/"):]
        self._serve_file(WEB_DIR / relative, cache=False)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    # ---------------------------------------------------------------- #
    # 静态文件
    # ---------------------------------------------------------------- #
    def _serve_file(self, path: Path, *, cache: bool, root: Path = WEB_DIR) -> None:
        try:
            resolved = path.resolve()
            resolved.relative_to(root.resolve())
        except (ValueError, OSError):
            self._not_found()
            return
        if not resolved.is_file():
            self._not_found()
            return
        try:
            data = resolved.read_bytes()
        except OSError:
            self._error(500, "读取文件失败")
            return
        self._send_bytes(
            data,
            _guess_content_type(resolved),
            cache_control="public, max-age=3600" if cache else "no-store",
        )

    # ---------------------------------------------------------------- #
    # 瓦片代理
    # ---------------------------------------------------------------- #
    def _serve_tile(self, rest: str) -> None:
        parts = rest.split("/")
        if len(parts) != 4:
            self._not_found()
            return
        source, z, x, y = parts
        if source not in TILE_SOURCES:
            self._not_found()
            return
        if not (z.isdigit() and x.isdigit() and y.isdigit()):
            self._not_found()
            return
        if int(z) > 20:
            self._not_found()
            return

        template, extension = TILE_SOURCES[source]
        cache_path = CACHE_DIR / source / z / x / f"{y}{extension}"

        if cache_path.is_file():
            data = cache_path.read_bytes()
            self._send_bytes(
                data,
                sniff_image_type(data) or CONTENT_TYPES[extension],
                cache_control="public, max-age=86400",
            )
            return

        url = template.format(z=z, x=x, y=y)
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=15) as response:
                data = response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            print(f"[tile] 失败 {source} {z}/{x}/{y}: {error}", file=sys.stderr)
            self._error(502, "瓦片获取失败")
            return

        image_type = sniff_image_type(data)
        if image_type is None:
            # 上游返回错误页（或其他非图片内容）时不要当瓦片缓存
            self._error(502, "瓦片内容异常")
            return

        try:
            with _CACHE_LOCK:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = cache_path.with_suffix(cache_path.suffix + f".{threading.get_ident()}.tmp")
                temporary.write_bytes(data)
                temporary.replace(cache_path)
        except OSError:
            pass  # 缓存失败不影响返回

        self._send_bytes(data, image_type, cache_control="public, max-age=86400")

    # ---------------------------------------------------------------- #
    # 响应辅助
    # ---------------------------------------------------------------- #
    def _send_bytes(self, data: bytes, content_type: str, *, cache_control: str = "no-store") -> None:
        try:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache_control)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # 浏览器取消请求（例如快速缩放地图）时忽略

    def _not_found(self) -> None:
        self._error(404, "未找到")

    def _error(self, status: int, message: str) -> None:
        body = message.encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def log_message(self, fmt: str, *args) -> None:  # 安静一点，只记录非 200
        try:
            status = int(args[1])
        except (IndexError, ValueError, TypeError):
            status = 200
        if status >= 400:
            super().log_message(fmt, *args)


class ThreadingServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def pick_port(host: str, preferred: int, attempts: int = 20) -> int:
    for offset in range(attempts):
        port = preferred + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, port))
            except OSError:
                continue
            return port
    raise SystemExit(f"{preferred}~{preferred + attempts - 1} 端口都被占用")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NMEA 分析平台本地服务器")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args(argv)

    if not (WEB_DIR / "index.html").is_file():
        print(f"缺少 {WEB_DIR / 'index.html'}", file=sys.stderr)
        return 2

    port = pick_port(args.host, args.port)
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{port}/"

    try:
        server = ThreadingServer((args.host, port), Handler)
    except OSError as error:
        print(f"启动失败: {error}", file=sys.stderr)
        return 1

    print("=" * 56)
    print("NMEA 分析平台已启动")
    print(f"  地址: {url}")
    print(f"  数据: {ROOT / 'nmea.log'}")
    print(f"  缓存: {CACHE_DIR}")
    print("  按 Ctrl+C 退出")
    print("=" * 56)

    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
