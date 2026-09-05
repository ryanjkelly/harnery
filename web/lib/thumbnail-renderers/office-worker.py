"""Private JSON-lines worker: one warm office process, sequential first-page exports."""
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

try:
    import uno
except ImportError:
    print(json.dumps({"error": "converter_missing:uno"}), flush=True)
    sys.exit(1)

profile = tempfile.mkdtemp(prefix="harn-thumb-office-")
office = None
desktop = None


def property_value(name, value):
    prop = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    prop.Name = name
    prop.Value = value
    return prop


def terminate(_signal, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)

try:
    user = Path(profile) / "user"
    user.mkdir()
    (user / "registrymodifications.xcu").write_text('''<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item></oor:items>''')
    pipe = "harn_thumbnail_" + uuid.uuid4().hex
    office = subprocess.Popen([
        "libreoffice", "-env:UserInstallation=" + Path(profile).as_uri(),
        "--headless", "--invisible", "--nologo", "--nodefault", "--norestore", "--nofirststartwizard",
        "--accept=pipe,name=" + pipe + ";urp;StarOffice.ComponentContext",
    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=os.name != "nt")
    print(json.dumps({"type": "office", "pid": office.pid, "profile": profile}), flush=True)
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    deadline = time.monotonic() + 10
    while True:
        try:
            remote = resolver.resolve("uno:pipe,name=" + pipe + ";urp;StarOffice.ComponentContext")
            desktop = remote.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", remote)
            break
        except Exception:
            if time.monotonic() >= deadline or office.poll() is not None:
                raise RuntimeError("thumbnail_office_start_failed")
            time.sleep(0.04)

    started = time.monotonic()
    # Idle for two minutes, recycle after ten minutes or 256 completed documents.
    for _index in range(256):
        if time.monotonic() - started > 600 or not select.select([sys.stdin], [], [], 120)[0]:
            break
        line = sys.stdin.buffer.readline(65537)
        if not line or len(line) > 65536:
            break
        message = json.loads(line)
        document = None
        try:
            document = desktop.loadComponentFromURL(Path(message["inputPath"]).as_uri(), "_blank", 0, (
                property_value("Hidden", True), property_value("ReadOnly", True),
                property_value("MacroExecutionMode", uno.getConstantByName("com.sun.star.document.MacroExecMode.NEVER_EXECUTE")),
                property_value("UpdateDocMode", uno.getConstantByName("com.sun.star.document.UpdateDocMode.NO_UPDATE")),
            ))
            if document is None:
                raise RuntimeError("thumbnail_office_failed")
            document.storeToURL(Path(message["outputPath"]).as_uri(), (
                property_value("FilterName", message["filter"]), property_value("Overwrite", True),
                property_value("FilterData", uno.Any("[]com.sun.star.beans.PropertyValue", (property_value("PageRange", "1"),))),
            ))
            print(json.dumps({"id": message["id"], "ok": True, "retire": _index >= 255 or time.monotonic() - started > 600}), flush=True)
        except Exception:
            print(json.dumps({"id": message.get("id"), "error": "thumbnail_office_failed"}), flush=True)
        finally:
            if document is not None:
                try:
                    document.close(True)
                except Exception:
                    document.dispose()
except Exception:
    print(json.dumps({"error": "thumbnail_office_start_failed"}), flush=True)
finally:
    if office is not None:
        try:
            if os.name != "nt":
                os.killpg(office.pid, signal.SIGKILL)
            else:
                office.kill()
        except ProcessLookupError:
            pass
        office.wait()
    shutil.rmtree(profile, ignore_errors=True)
