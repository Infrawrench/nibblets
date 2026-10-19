# The agent's port on Hyper-V: a Hyper-V socket (vsock, through hv_sock),
# relayed over this process's stdio for the guest agent, since Node can't
# open one. It listens for good and takes the host's connections one at a
# time, so to the agent it's a serial line: one stream, whoever's on the
# other end, and what's written with no one there goes nowhere.
#
# Only the host is let in: Hyper-V says who's calling (its CID, 2 for the
# host), so nothing in this VM can pose as it and run things as root.
#
#   python3 hvsock-relay.py <vsock port>

import os
import socket
import sys
import threading

port = int(sys.argv[1])
lock = threading.Lock()
current = None


def to_host():
    """The agent's output, to whichever connection is the host's now."""
    while True:
        data = os.read(0, 65536)
        if not data:
            os._exit(0)
        with lock:
            conn = current
        if conn is not None:
            try:
                conn.sendall(data)
            except OSError:
                pass


threading.Thread(target=to_host, daemon=True).start()

listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
listener.bind((socket.VMADDR_CID_ANY, port))
listener.listen(1)
print(f"nibblet-hvsock: listening on vsock port {port}", file=sys.stderr, flush=True)

while True:
    conn, (cid, _) = listener.accept()
    if cid != socket.VMADDR_CID_HOST:
        conn.close()
        continue
    with lock:
        current = conn
    try:
        while True:
            data = conn.recv(65536)
            if not data:
                break
            view = memoryview(data)
            while view:
                view = view[os.write(1, view) :]
    except OSError:
        pass
    with lock:
        if current is conn:
            current = None
    conn.close()
