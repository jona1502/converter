"""Echte Linuxproben der Sandbox: Netzwerk, x32, RLIMITs, Walltimer, Parent-Death.

Jede Probe läuft in einem eigenen Kindprozess, weil seccomp und RLIMITs nicht
umkehrbar sind. Unter Windows (nur Entwicklungsumgebung) gibt es weder
seccomp noch RLIMITs oder PR_SET_PDEATHSIG; ``isolate`` ist dort bewusst ein
No-op, daher werden diese Tests übersprungen und im Linux-Testcontainer
ausgeführt.
"""

from __future__ import annotations

import json
import signal
import socket
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from tests.helpers import ROOT, child_env, encode, new_id, request, target_file

pytestmark = pytest.mark.skipif(
    sys.platform != "linux",
    reason="seccomp/RLIMIT/PR_SET_PDEATHSIG gibt es nur unter Linux (Testcontainer)",
)


def sandboxed(
    body: str,
    *,
    memory: int = 1 << 30,
    timeout: int = 30,
    output: int = 1 << 20,
    wait: float = 60,
) -> subprocess.CompletedProcess[bytes]:
    script = (
        "import ctypes, errno, json, os, socket, sys, time\n"
        "from converter.sandbox import isolate\n"
        f"isolate({memory}, {timeout}, {output})\n" + textwrap.dedent(body)
    )
    return subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        cwd=ROOT,
        env=child_env(),
        timeout=wait,
        check=False,
    )


def _listener() -> tuple[socket.socket, int]:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(8)
    return server, server.getsockname()[1]


def test_internal_target_is_reachable_without_sandbox() -> None:
    """Gegenprobe: ohne Sandbox erreicht ein Kindprozess das interne Ziel."""
    server, port = _listener()
    with server:
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                f"import socket; socket.create_connection(('127.0.0.1', {port}), 5).close()",
            ],
            capture_output=True,
            env=child_env(),
            timeout=30,
            check=False,
        )
    assert completed.returncode == 0, completed.stderr


def test_sockets_denied_for_all_families_and_internal_targets(tmp_path: Path) -> None:
    server, port = _listener()
    unix_path = tmp_path / "internal.sock"
    unix_server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    unix_server.bind(str(unix_path))
    unix_server.listen(1)
    with server, unix_server:
        completed = sandboxed(
            f"""
            results = {{}}
            attempts = {{
                "tcp": lambda: socket.create_connection(("127.0.0.1", {port}), 5),
                "inet6": lambda: socket.socket(socket.AF_INET6, socket.SOCK_DGRAM),
                "unix": lambda: socket.socket(socket.AF_UNIX).connect({str(unix_path)!r}),
                "netlink": lambda: socket.socket(socket.AF_NETLINK, socket.SOCK_RAW),
                "packet": lambda: socket.socket(socket.AF_PACKET, socket.SOCK_RAW),
                "socketpair": lambda: socket.socketpair(),
            }}
            for name, attempt in attempts.items():
                try:
                    attempt()
                    results[name] = "allowed"
                except OSError as exc:
                    results[name] = errno.errorcode.get(exc.errno, str(exc.errno))
            libc = ctypes.CDLL(None, use_errno=True)
            libc.syscall.restype = ctypes.c_long
            # io_uring_setup(1, NULL) wäre ein alternativer Pfad an seccomp vorbei.
            rc = libc.syscall(425, 1, None)
            results["io_uring"] = errno.errorcode.get(ctypes.get_errno()) if rc < 0 else "allowed"
            print(json.dumps(results))
            """
        )
    assert completed.returncode == 0, completed.stderr
    results = json.loads(completed.stdout)
    assert results == {
        "tcp": "EPERM",
        "inet6": "EPERM",
        "unix": "EPERM",
        "netlink": "EPERM",
        "packet": "EPERM",
        "socketpair": "EPERM",
        "io_uring": "EPERM",
    }


def test_x32_syscall_alias_kills_process() -> None:
    completed = sandboxed(
        """
        libc = ctypes.CDLL(None, use_errno=True)
        libc.syscall.restype = ctypes.c_long
        libc.syscall(0x40000000 | 41, 2, 1, 0)  # x32-socket()
        print("survived")
        """
    )
    assert completed.returncode == -signal.SIGSYS
    assert b"survived" not in completed.stdout


def test_regular_file_io_still_works(tmp_path: Path) -> None:
    target = tmp_path / "ok"
    completed = sandboxed(
        f"""
        with open({str(target)!r}, "wb") as f:
            f.write(b"x" * 100)
        print("ok")
        """
    )
    assert completed.returncode == 0, completed.stderr
    assert target.read_bytes() == b"x" * 100


def test_rlimit_fsize_blocks_large_writes(tmp_path: Path) -> None:
    target = tmp_path / "big"
    completed = sandboxed(
        f"""
        # Der Kernel kürzt den Schreibvorgang an der Grenze; der nächste
        # scheitert mit EFBIG (Python ignoriert SIGXFSZ).
        try:
            with open({str(target)!r}, "wb", buffering=0) as f:
                for _ in range(3):
                    f.write(b"x" * 1000)
            print("written")
        except OSError as exc:
            print(errno.errorcode[exc.errno])
        """,
        output=1500,
    )
    assert completed.stdout.strip() == b"EFBIG", completed.stderr
    assert target.stat().st_size == 1500


def test_rlimit_as_limits_memory() -> None:
    completed = sandboxed(
        """
        try:
            data = bytearray(512 * 1024 * 1024)
            print("allocated")
        except MemoryError:
            print("memory-error")
        """,
        memory=256 * 1024 * 1024,
    )
    assert completed.stdout.strip() == b"memory-error", completed.stderr


def test_kernel_walltimer_kills_blocked_c_call() -> None:
    """alarm() trifft auch einen in C blockierten Prozess ohne Python-Handler."""
    started = time.monotonic()
    completed = sandboxed(
        """
        ctypes.CDLL(None).pause()  # blockiert im Kernel, verbraucht keine CPU
        print("woke up")
        """,
        timeout=1,
        wait=30,
    )
    elapsed = time.monotonic() - started
    assert completed.returncode == -signal.SIGALRM
    assert b"woke up" not in completed.stdout
    assert 1.5 <= elapsed < 15


def test_cpu_limit_kills_busy_loop() -> None:
    completed = sandboxed(
        """
        while True:
            pass
        """,
        timeout=1,
        wait=30,
    )
    assert completed.returncode in {-signal.SIGXCPU, -signal.SIGKILL}


def _state(pid: int) -> str | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return None
    return stat.rsplit(")", 1)[1].split()[0]


def test_parent_death_kills_sandboxed_child() -> None:
    grandchild = (
        "import os, sys, ctypes\n"
        "from converter.sandbox import isolate\n"
        "isolate(1 << 30, 60, 1 << 20)\n"
        "sys.stdout.write(f'{os.getpid()}\\n'); sys.stdout.flush()\n"
        "ctypes.CDLL(None).pause()\n"
    )
    intermediate = textwrap.dedent(
        f"""
        import subprocess, sys, time
        child = subprocess.Popen([sys.executable, "-c", {grandchild!r}], stdout=subprocess.PIPE)
        sys.stdout.write(child.stdout.readline().decode()); sys.stdout.flush()
        time.sleep(60)
        """
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", intermediate],
        stdout=subprocess.PIPE,
        cwd=ROOT,
        env=child_env(),
    )
    try:
        assert parent.stdout is not None
        pid = int(parent.stdout.readline())
        assert _state(pid) not in {None, "Z"}  # Gegenprobe: lebt vor dem Tod des Elternteils
        parent.kill()
        parent.wait(timeout=10)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and _state(pid) not in {None, "Z"}:
            time.sleep(0.05)
        assert _state(pid) in {None, "Z"}
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=10)
        if parent.stdout is not None:
            parent.stdout.close()


def test_refuses_when_parent_already_exited() -> None:
    grandchild = (
        "import time\n"
        "time.sleep(1)\n"  # Elternprozess ist inzwischen beendet (reparented)
        "from converter.sandbox import isolate\n"
        "try:\n"
        "    isolate(1 << 30, 60, 1 << 20)\n"
        "    print('isolated')\n"
        "except RuntimeError:\n"
        "    print('refused')\n"
    )
    intermediate = (
        "import os, subprocess, sys\n"
        f"subprocess.Popen([sys.executable, '-c', {grandchild!r}])\n"
        "os._exit(0)\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", intermediate],
        capture_output=True,
        cwd=ROOT,
        env=child_env(),
        timeout=30,
        check=False,
    )
    assert completed.stdout.strip() == b"refused", completed.stderr


def test_unknown_architecture_fails_closed(tmp_path: Path) -> None:
    """Die CLI meldet sandbox-failed statt ohne seccomp weiterzuarbeiten."""
    source = tmp_path / "input"
    source.write_bytes(b"irrelevant")
    target = target_file(tmp_path / "out")
    body = request(source, {"tool": "image-convert", "format": "png"}, [(new_id(), None, target)])
    script = (
        "import platform, sys\n"
        "platform.machine = lambda: 'mips'\n"
        "from converter.cli import main\n"
        "sys.exit(main(['run']))\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        input=encode(body),
        capture_output=True,
        cwd=ROOT,
        env=child_env(),
        timeout=30,
        check=False,
    )
    assert completed.returncode == 1
    assert json.loads(completed.stdout) == {"kind": "fatal", "code": "sandbox-failed"}
    assert target.stat().st_size == 0


def _seccomp_filters(status: str) -> int | None:
    for line in status.splitlines():
        if line.startswith("Seccomp_filters:"):
            return int(line.split()[1])
    return None


def test_cli_child_has_no_network(tmp_path: Path) -> None:
    """Auch der echte CLI-Prozess läuft mit eigenem seccomp-Filter ohne Sockets."""
    source = tmp_path / "input"
    source.write_bytes(b"irrelevant")
    target = target_file(tmp_path / "out")
    body = request(source, {"tool": "image-convert", "format": "png"}, [(new_id(), None, target)])
    # execute() wird ersetzt; alles davor (Prüfung, Isolation) ist der echte CLI-Pfad.
    script = textwrap.dedent(
        """
        import socket, sys, converter.execute as ex
        def check(request, writer):
            status = open('/proc/self/status').read()
            try:
                socket.socket()
                net = 'allowed'
            except PermissionError:
                net = 'denied'
            writer.analysis({'status': status, 'socket': net})
        ex.execute = check
        from converter.cli import main
        sys.exit(main(['run']))
        """
    )
    completed = subprocess.run(
        [sys.executable, "-c", script],
        input=encode(body),
        capture_output=True,
        cwd=ROOT,
        env=child_env(),
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    report = json.loads(completed.stdout)["analysis"]
    assert report["socket"] == "denied"
    own = _seccomp_filters(Path("/proc/self/status").read_text())
    child = _seccomp_filters(report["status"])
    if own is not None and child is not None:
        assert child == own + 1
