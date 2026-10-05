"""Host for a Python run file: `python -m agentsh FILE READ_FD WRITE_FD`, started by agent-sh."""
import importlib.util
import os
import sys
import traceback


def main():
    file, read_fd, write_fd = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    sys.path.insert(0, os.path.dirname(os.path.abspath(file)))
    import agentsh
    try:
        spec = importlib.util.spec_from_file_location("__workflow__", file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except BaseException:  # noqa: BLE001
        chan = agentsh._Channel(read_fd, write_fd)
        chan.send({"t": "hello", "error": traceback.format_exc(limit=-3).strip()})
        return 1
    return agentsh._serve(module, read_fd, write_fd)


sys.exit(main())
