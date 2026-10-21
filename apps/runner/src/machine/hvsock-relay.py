# The agent's port on Hyper-V: a Hyper-V socket (vsock, through hv_sock),
# relayed over this process's stdio for the guest agent, since Node can't
# open one. It listens for good, and the host's newest connection is the
# one: a connection the host has given up on can look open from here for
# a long while, and waiting it out would leave the host's next one unheard.
# So to the agent it's a serial line: one stream, whoever's on the other
# end, and what's written with no one there goes nowhere.
#
# Only the host is let in: Hyper-V says who's calling (its CID, 2 for the
# host), so nothing in this VM can pose as it and run things as root.
#
#   python3 hvsock-relay.py <vsock port>
#
# On Apple Virtualization the host listens instead: with --connect it
# connects to it, and ends when either side does (--probe: just to see if
# it can). The agent's port there was a virtio console, a tty, which stalled.
#
#   python3 hvsock-relay.py --connect <vsock port> [--probe]

import os
import socket
import sys
import threading

if sys.argv[1] == "--connect":
    conn = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        conn.connect((socket.VMADDR_CID_HOST, int(sys.argv[2])))
    except OSError as e:
        print(f"nibblet-vsock: no host to connect to: {e}", file=sys.stderr, flush=True)
        sys.exit(3)
    if "--probe" in sys.argv:
        conn.close()
        sys.exit(0)

    def from_host():
        while data := conn.recv(65536):
            view = memoryview(data)
            while view:
                view = view[os.write(1, view) :]
        os._exit(0)

    threading.Thread(target=from_host, daemon=True).start()
    while data := os.read(0, 65536):
        conn.sendall(data)
    os._exit(0)

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
listener.listen(4)
print(f"nibblet-hvsock: listening on vsock port {port}", file=sys.stderr, flush=True)

def from_host(conn):
    """What the host sends on `conn`, to the agent, for as long as it's the host's newest."""
    global current
    try:
        while True:
            data = conn.recv(65536)
            if not data:
                break
            # Under the lock, so an old connection can't write once a new one has taken over.
            with lock:
                if current is not conn:
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


while True:
    conn, (cid, _) = listener.accept()
    if cid != socket.VMADDR_CID_HOST:
        conn.close()
        continue
    with lock:
        old, current = current, conn
    if old is not None:
        print("nibblet-hvsock: the host connected again; dropping its last connection", file=sys.stderr, flush=True)
        try:
            old.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    threading.Thread(target=from_host, args=(conn,), daemon=True).start()
