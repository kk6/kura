"""検証用の Kura の通信を通す、HTTPS の CONNECT だけを中継するプロキシ。使い方は features/similarity.md

kura-verify.sh の net up が起動し、net down が止める。止めると中継中の通信も切れる（ダウンロードの途中で切れた状態）。
つないだ先を1行ずつ標準出力に書くので、通信した記録（NFR-08）にもなる。
"""

import socket
import sys
import threading
import time


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while data := src.recv(65536):
            dst.sendall(data)
    except OSError as e:
        log(f"切れた {e}")
    finally:
        dst.close()


def handle(client: socket.socket) -> None:
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = client.recv(4096)
        if not chunk:
            client.close()
            return
        head += chunk
    line = head.split(b"\r\n", 1)[0].decode("latin-1")
    method, target, _ = line.split(" ", 2)
    if method != "CONNECT":
        log(f"拒否 {line}")
        client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
        client.close()
        return
    host, port = target.rsplit(":", 1)
    try:
        upstream = socket.create_connection((host, int(port)), timeout=30)
        upstream.settimeout(None)
    except OSError as e:
        log(f"つなげない {target} {e}")
        client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        client.close()
        return
    log(f"CONNECT {target}")
    client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
    threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()
    pipe(client, upstream)


def main() -> None:
    port = int(sys.argv[1])
    server = socket.create_server(("127.0.0.1", port))
    log(f"待ち受け 127.0.0.1:{port}")
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
