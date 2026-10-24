"""Linux-Sandbox für den reinen Parserprozess (keine Broker-/DB-Verbindung)."""

from __future__ import annotations

import ctypes
import errno
import importlib
import os
import platform


def isolate(memory_bytes: int, timeout_seconds: int, output_bytes: int) -> None:
    if platform.system() != "Linux":
        # Windows ist ausschließlich Entwicklungs-/Testumgebung.
        return
    resource = importlib.import_module("resource")

    # Der Kernel beendet auch bei blockiertem C-Parser und nach einem Crash des
    # überwachenden Workers. SIGALRM hat bewusst keinen Python-Handler.
    signals = importlib.import_module("signal")
    signals.signal(signals.SIGALRM, signals.SIG_DFL)
    signals.alarm(timeout_seconds + 1)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signals.SIGKILL, 0, 0, 0):
        raise OSError(ctypes.get_errno(), "parent-death signal unavailable")
    if os.getppid() == 1:
        raise RuntimeError("parent already exited")

    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (timeout_seconds, timeout_seconds + 1))
    resource.setrlimit(resource.RLIMIT_FSIZE, (output_bytes, output_bytes))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    deny_network()


def deny_network() -> None:
    """Seccomp-BPF verbietet neue Sockets, auch zu internen Diensten.

    Der Kindprozess erbt ausschließlich stdin/stdout und keine Netzwerksockets.
    Bei unbekannter Architektur oder fehlendem seccomp schlägt er geschlossen fehl.
    """

    class Filter(ctypes.Structure):
        _fields_ = [
            ("code", ctypes.c_ushort),
            ("jt", ctypes.c_ubyte),
            ("jf", ctypes.c_ubyte),
            ("k", ctypes.c_uint),
        ]

    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]

    architecture = platform.machine().lower()
    if architecture in {"x86_64", "amd64"}:
        arch, blocked = 0xC000003E, [41, 42, 44, 46, 53, 307, 425]
    elif architecture in {"aarch64", "arm64"}:
        arch, blocked = 0xC00000B7, [198, 199, 203, 206, 211, 269, 425]
    else:
        raise RuntimeError("unsupported sandbox architecture")
    instructions = [
        Filter(0x20, 0, 0, 4),
        Filter(0x15, 1, 0, arch),
        Filter(0x06, 0, 0, 0x80000000),
        Filter(0x20, 0, 0, 0),
        # Block x32 syscall-number aliases as well as unsupported ABI numbers.
        Filter(0x35, 0, 1, 0x40000000),
        Filter(0x06, 0, 0, 0x80000000),
    ]
    for number in blocked:
        instructions.extend(
            [Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM)]
        )
    instructions.append(Filter(0x06, 0, 0, 0x7FFF0000))
    filters = (Filter * len(instructions))(*instructions)
    program = Program(len(instructions), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(program), 0, 0):
        raise OSError(ctypes.get_errno(), "seccomp unavailable")
