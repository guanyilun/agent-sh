"""Started by agent-sh for a Python workflow file: python -m agentsh FILE READ_FD WRITE_FD."""
import importlib.util
import os
import sys
import traceback

from agentsh import _host


def main():
    file, read_fd, write_fd = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    sys.path.insert(0, os.path.dirname(os.path.abspath(file)))
    try:
        spec = importlib.util.spec_from_file_location("__workflow__", file)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module  # dataclasses and typing look the module up by name
        spec.loader.exec_module(module)
    except BaseException:  # noqa: BLE001 - report anything that stops the file from loading
        _host.Connection(read_fd, write_fd).send("hello", error=traceback.format_exc(limit=-3).strip())
        return 1
    return _host.serve(module, read_fd, write_fd)


sys.exit(main())
