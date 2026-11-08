# Fresh real CLI + public extension callback, not a private prototype/context probe.
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import sys
import termios
import time

sdk, work = map(Path, sys.argv[1:])
proof = work / 'native-ui.json'
extension = work / 'native-capability.mjs'
extension.write_text('''import fs from 'node:fs';
export default function (pi) {
  pi.on('session_start', (_event, ctx) => {
    fs.writeFileSync(process.env.NATIVE_CAPABILITY_PROOF, JSON.stringify({
      capability: ctx.ui.themeWatchCapability, mode: ctx.mode, hasUI: ctx.hasUI
    }));
    ctx.shutdown();
  });
}
''')
pid, master = pty.fork()
if pid == 0:
    os.chdir(work)
    os.environ['NATIVE_CAPABILITY_PROOF'] = str(proof)
    os.execv(shutil.which('node'), ['node', str(sdk / 'dist/bundle/cli.js'),
        '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
        '--no-themes', '-e', str(extension)])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
transcript = bytearray()
status = None
def timeout(_signal, _frame):
    raise TimeoutError('Fresh native CLI did not exit within 45 seconds')
signal.signal(signal.SIGALRM, timeout)
signal.alarm(45)
try:
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], min(0.2, max(0, deadline - time.monotonic())))
        if readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    _, status = os.waitpid(pid, 0)
                    break
                raise
            if not data:
                _, status = os.waitpid(pid, 0)
                break
            transcript.extend(data)
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
        done, value = os.waitpid(pid, os.WNOHANG)
        if done:
            status = value
            break
    if status is None:
        done, value = os.waitpid(pid, os.WNOHANG)
        if done:
            status = value
    assert proof.exists(), 'Native session_start proof absent; inspect native-terminal.log'
    result = json.loads(proof.read_text())
    assert result == {'capability': 'pi.theme-watch.file-version.v1', 'mode': 'tui', 'hasUI': True}, result
    assert status is not None and os.waitstatus_to_exitcode(status) == 0, status
    print('PASS fresh real CLI public NativeUI capability:', json.dumps(result))
finally:
    signal.alarm(0)
    (work / 'native-terminal.log').write_bytes(transcript)
    if status is None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(master)
