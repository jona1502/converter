"""Linux-Sandbox für den reinen Parserprozess (übernommen aus backend/app/worker/sandbox.py).

Wird vor dem Import nativer Parser aufgerufen und ist danach nicht mehr
umkehrbar: Kernel-Walltimer (``alarm``), Parent-Death-Signal, RLIMITs und ein
seccomp-Filter, der neue Sockets auch zu internen Diensten verbietet.
"""

from __future__ import annotations

import ctypes
import errno
import importlib
import os
import platform
from typing import Final

PR_SET_PDEATHSIG: Final = 1
PR_SET_SECCOMP: Final = 22
PR_SET_NO_NEW_PRIVS: Final = 38
SECCOMP_MODE_FILTER: Final = 2
SECCOMP_RET_KILL_PROCESS: Final = 0x80000000
SECCOMP_RET_ERRNO: Final = 0x00050000
SECCOMP_RET_ALLOW: Final = 0x7FFF0000
X32_SYSCALL_BIT: Final = 0x40000000

# Gleiche Nummern wie im Backend. x86_64: socket 41, connect 42, sendto 44,
# sendmsg 46, socketpair 53, sendmmsg 307, io_uring_setup 425. aarch64:
# socket 198, socketpair 199, connect 203, sendto 206, sendmsg 211,
# sendmmsg 269, io_uring_setup 425. AUDIT_ARCH_* als Architekturkennung.
BLOCKED_SYSCALLS: Final = {
    "x86_64": (0xC000003E, (41, 42, 44, 46, 53, 307, 425)),
    "aarch64": (0xC00000B7, (198, 199, 203, 206, 211, 269, 425)),
}


def _libc() -> ctypes.CDLL:
    libc = ctypes.CDLL(None, use_errno=True)
    # Explizite Argumenttypen: prctl erwartet unsigned long, und einige
    # Optionen verlangen exakt 0 in den ungenutzten Argumenten.
    libc.prctl.argtypes = [ctypes.c_int, *([ctypes.c_ulong] * 4)]
    libc.prctl.restype = ctypes.c_int
    return libc


def isolate(memory_bytes: int, timeout_seconds: int, output_bytes: int) -> None:
    if platform.system() != "Linux":
        # Windows ist ausschließlich Entwicklungs-/Testumgebung.
        return
    resource = importlib.import_module("resource")
    parent = os.getppid()

    # Der Kernel beendet auch bei blockiertem C-Parser und nach einem Crash des
    # überwachenden Workers. SIGALRM hat bewusst keinen Python-Handler.
    signals = importlib.import_module("signal")
    signals.signal(signals.SIGALRM, signals.SIG_DFL)
    signals.alarm(timeout_seconds + 1)
    libc = _libc()
    if libc.prctl(PR_SET_PDEATHSIG, signals.SIGKILL, 0, 0, 0):
        raise OSError(ctypes.get_errno(), "parent-death signal unavailable")
    # Starb der Elternprozess vor prctl, greift das Signal nie: dann wurde der
    # Prozess an init (PID 1) oder einen Subreaper weitergereicht.
    if parent == 1 or os.getppid() != parent:
        raise RuntimeError("parent already exited")

    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (timeout_seconds, timeout_seconds + 1))
    resource.setrlimit(resource.RLIMIT_FSIZE, (output_bytes, output_bytes))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    deny_network()


def deny_network() -> None:
    """Seccomp-BPF verbietet neue Sockets, auch zu internen Diensten.

    Der Kindprozess erbt ausschließlich stdin/stdout/stderr und keine
    Netzwerksockets. Bei unbekannter Architektur oder fehlendem seccomp
    schlägt er geschlossen fehl.
    """

    class Filter(ctypes.Structure):
        _fields_ = (
            ("code", ctypes.c_ushort),
            ("jt", ctypes.c_ubyte),
            ("jf", ctypes.c_ubyte),
            ("k", ctypes.c_uint),
        )

    class Program(ctypes.Structure):
        _fields_ = (("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter)))

    architecture = platform.machine().lower()
    architecture = {"amd64": "x86_64", "arm64": "aarch64"}.get(architecture, architecture)
    if architecture not in BLOCKED_SYSCALLS:
        raise RuntimeError("unsupported sandbox architecture")
    arch, blocked = BLOCKED_SYSCALLS[architecture]
    instructions = [
        Filter(0x20, 0, 0, 4),  # ld seccomp_data.arch
        Filter(0x15, 1, 0, arch),  # jeq arch
        Filter(0x06, 0, 0, SECCOMP_RET_KILL_PROCESS),
        Filter(0x20, 0, 0, 0),  # ld seccomp_data.nr
        # x32-Aliasnummern und unbekannte ABI-Nummern ebenfalls sperren.
        Filter(0x35, 0, 1, X32_SYSCALL_BIT),  # jge
        Filter(0x06, 0, 0, SECCOMP_RET_KILL_PROCESS),
    ]
    for number in blocked:
        instructions.extend(
            [Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, SECCOMP_RET_ERRNO | errno.EPERM)]
        )
    instructions.append(Filter(0x06, 0, 0, SECCOMP_RET_ALLOW))
    filters = (Filter * len(instructions))(*instructions)
    program = Program(len(instructions), filters)
    libc = _libc()
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) or libc.prctl(
        PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.addressof(program), 0, 0
    ):
        raise OSError(ctypes.get_errno(), "seccomp unavailable")
