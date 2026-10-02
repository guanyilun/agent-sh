#!/usr/bin/env python3
"""Landlock OS sandbox for Linux when bubblewrap isn't usable (needs Linux 5.13+ with Landlock enabled).

  landlock.py --probe                        exit 0 and print the ABI version if Landlock works here
  landlock.py --plan [options]               print the rules as JSON without applying them (for tests)
  landlock.py [options] -- CMD [ARGS...]     apply the rules to this process, then exec CMD

options: --rw DIR (writable), --hide PATH (unreadable), --home AGENT_SH_HOME (its entries writable, except settings,
keys, extensions, agents and workflows). Also writable: /tmp, /var/tmp, /dev/shm, $TMPDIR; /dev files for writing.

Landlock only allows, so hiding a path means allowing reads beside it at each level of its path: entries created
later next to a hidden path's ancestors aren't readable, and names inside a hidden dir can be listed (not read).
New top-level entries in the home can't be created. Network and processes aren't restricted.
"""
import ctypes
import json
import os
import stat
import struct
import sys

HOME_READ_ONLY = {"settings.json", "keys.json", "extensions", "agents", "workflows"}
SYS_CREATE, SYS_ADD_RULE, SYS_RESTRICT = 444, 445, 446  # the same on every Linux architecture
PR_SET_NO_NEW_PRIVS = 38
RULE_PATH_BENEATH = 1

EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1 << 0, 1 << 1, 1 << 2, 1 << 3
WRITE_DIR = sum(1 << b for b in range(4, 13))  # remove dir/file, make char/dir/reg/sock/fifo/block/sym
REFER, TRUNCATE = 1 << 13, 1 << 14
READ = READ_FILE | READ_DIR
FILE_RIGHTS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE  # rights that apply to a non-directory


def write_rights(abi):
    return WRITE_FILE | WRITE_DIR | (REFER if abi >= 2 else 0) | (TRUNCATE if abi >= 3 else 0)


def plan(rw, hide, home, abi):
    """The rules: [(path, rights)], plus the rights this ruleset handles (everything else stays allowed)."""
    real = lambda p: os.path.realpath(os.path.expanduser(p))
    rw, hide = [real(p) for p in rw], [real(p) for p in hide]
    w = write_rights(abi)
    handled = w | (READ if hide else 0)
    rules = []

    writable = rw + ["/tmp", "/var/tmp", "/dev/shm"] + ([real(os.environ["TMPDIR"])] if os.environ.get("TMPDIR") else [])
    for p in writable:
        rules.append((p, w))
    rules.append(("/dev", WRITE_FILE))  # /dev/null, /dev/tty, /dev/pts/*
    if home and os.path.isdir(home):
        home = real(home)
        for name in sorted(os.listdir(home)):
            if name not in HOME_READ_ONLY:
                rules.append((os.path.join(home, name), w))

    if hide:
        # Directory listings stay allowed everywhere; file contents are allowed beside each hidden path, level by level.
        rules.append(("/", READ_DIR))

        def beside(d):
            try:
                names = os.listdir(d)
            except OSError:
                return
            for name in sorted(names):
                p = os.path.join(d, name)
                if p in hide:
                    continue
                if any(h.startswith(p + "/") for h in hide):
                    beside(p)
                else:
                    rules.append((p, READ))
        beside("/")
    return rules, handled


def libc():
    lib = ctypes.CDLL(None, use_errno=True)
    lib.syscall.restype = ctypes.c_long
    return lib


def check(r, what):
    if r < 0:
        e = ctypes.get_errno()
        raise OSError(e, f"{what}: {os.strerror(e)}")
    return r


def abi_version(lib):
    try:
        return check(lib.syscall(SYS_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(1)), "landlock_create_ruleset")
    except OSError as e:
        reason = {38: "this kernel has no Landlock (needs Linux 5.13+)", 95: "Landlock is disabled in this kernel"}.get(e.errno, e.strerror)
        raise SystemExit(f"landlock: {reason}")


def apply(rules, handled, abi, lib):
    # struct landlock_ruleset_attr { u64 handled_access_fs; u64 handled_access_net (ABI 4+); }
    attr = struct.pack("=QQ", handled, 0) if abi >= 4 else struct.pack("=Q", handled)
    abuf = ctypes.create_string_buffer(attr, len(attr))
    fd = check(lib.syscall(SYS_CREATE, abuf, ctypes.c_size_t(len(attr)), ctypes.c_uint32(0)), "landlock_create_ruleset")
    for path, rights in rules:
        try:
            pfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError:
            continue  # gone or unreachable: nothing to allow
        try:
            if not stat.S_ISDIR(os.fstat(pfd).st_mode):
                rights &= FILE_RIGHTS
            rights &= handled
            if rights:
                # struct landlock_path_beneath_attr { u64 allowed_access; s32 parent_fd; } __attribute__((packed))
                rule = ctypes.create_string_buffer(struct.pack("=Qi", rights, pfd), 12)
                check(lib.syscall(SYS_ADD_RULE, ctypes.c_int(fd), ctypes.c_int(RULE_PATH_BENEATH), rule, ctypes.c_uint32(0)), f"landlock_add_rule {path}")
        finally:
            os.close(pfd)
    check(lib.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "prctl(NO_NEW_PRIVS)")
    check(lib.syscall(SYS_RESTRICT, ctypes.c_int(fd), ctypes.c_uint32(0)), "landlock_restrict_self")


def main(argv):
    mode, rw, hide, home, cmd = "run", [], [], None, []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--probe", "--plan"):
            mode = a[2:]
        elif a == "--rw":
            rw.append(argv[i + 1]); i += 1
        elif a == "--hide":
            hide.append(argv[i + 1]); i += 1
        elif a == "--home":
            home = argv[i + 1]; i += 1
        elif a == "--":
            cmd = argv[i + 1:]; break
        else:
            raise SystemExit(f"landlock.py: unknown option {a}")
        i += 1

    if mode == "plan":
        rules, handled = plan(rw, hide, home, abi=3)
        print(json.dumps({"handled": handled, "rules": rules}))
        return
    if not sys.platform.startswith("linux"):
        raise SystemExit(f"landlock: Landlock is Linux-only (this is {sys.platform})")
    lib = libc()
    abi = abi_version(lib)
    if mode == "probe":
        print(f"landlock ABI {abi}")
        return
    if not cmd:
        raise SystemExit("landlock.py: no command")
    for d in rw:
        os.makedirs(d, exist_ok=True)
    rules, handled = plan(rw, hide, home, abi)
    apply(rules, handled, abi, lib)
    os.environ.update(SBX_SANDBOXED="1", SBX_SANDBOX_KIND="landlock", XDG_CACHE_HOME="/tmp/.cache")
    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main(sys.argv[1:])
