"""
Runs a command in a pseudo-terminal, for the user's terminal in the
container. Python's pty module rather than node-pty, which would need a
compiler the runner image doesn't have.

    python3 -I terminal-pty.py <rows> <cols> <command> [args...]

stdin goes to the terminal and the terminal's output comes out on stdout.
Lines of "<rows> <cols>" on fd 3 resize it. Exits with the command's code
(128 + the signal, for a signal), and hangs the command up when stdin closes.
"""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]


def main():
    rows, cols = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)
    # From this side, so a resize that arrives straight away can't be undone
    # by the child getting round to it late.
    set_size(master, rows, cols)

    inputs = [0, 3, master]
    control = b""
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                os.kill(pid, signal.SIGHUP)
                inputs.remove(0)
            else:
                write_all(master, data)
        if 3 in ready:
            data = os.read(3, 4096)
            if not data:
                inputs.remove(3)
            control += data
            while b"\n" in control:
                line, control = control.split(b"\n", 1)
                parts = line.split()
                # The kernel tells the foreground program (SIGWINCH) itself.
                if len(parts) == 2:
                    set_size(master, int(parts[0]), int(parts[1]))

    _, status = os.waitpid(pid, 0)
    if os.WIFSIGNALED(status):
        sys.exit(128 + os.WTERMSIG(status))
    sys.exit(os.WEXITSTATUS(status))


if __name__ == "__main__":
    main()
