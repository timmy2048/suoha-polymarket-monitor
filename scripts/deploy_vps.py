from __future__ import annotations

import io
import os
import tarfile
import time
from pathlib import Path

import paramiko


LOCAL_ROOT = Path(__file__).resolve().parents[1]
REMOTE_ROOT = "/opt/suoha-polymarket-monitor"
SERVICE_NAME = "suoha-polymarket-monitor"

EXCLUDED_DIRS = {"node_modules", "data", "dist", ".git"}
EXCLUDED_FILES = {".env", ".env.local"}


def main() -> None:
    host = require_env("VPS_HOST")
    username = os.environ.get("VPS_USER", "root")
    password = require_env("VPS_PASSWORD")
    port = int(os.environ.get("VPS_PORT", "22"))

    archive = build_archive()
    remote_archive = f"/tmp/{SERVICE_NAME}-{int(time.time())}.tar.gz"

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=host, port=port, username=username, password=password, timeout=20)

    try:
        print(run(client, "uname -a"))
        upload_bytes(client, archive, remote_archive)
        run(client, f"mkdir -p {REMOTE_ROOT}")
        run(client, f"tar -xzf {remote_archive} -C {REMOTE_ROOT}")
        run(client, f"rm -f {remote_archive}")
        ensure_node(client)
        run(client, f"cd {REMOTE_ROOT} && npm ci")
        install_service(client)
        run(client, "systemctl daemon-reload")
        run(client, f"systemctl enable {SERVICE_NAME}.service")
        run(client, f"systemctl restart {SERVICE_NAME}.service")
        print(run(client, f"systemctl is-active {SERVICE_NAME}.service"))
        print(run(client, f"journalctl -u {SERVICE_NAME}.service -n 30 --no-pager"))
    finally:
        client.close()


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def build_archive() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for path in LOCAL_ROOT.rglob("*"):
            relative = path.relative_to(LOCAL_ROOT)
            if should_exclude(relative):
                continue
            tar.add(path, arcname=relative.as_posix())
    buffer.seek(0)
    return buffer.read()


def should_exclude(relative: Path) -> bool:
    parts = set(relative.parts)
    if parts & EXCLUDED_DIRS:
        return True
    return relative.name in EXCLUDED_FILES


def upload_bytes(client: paramiko.SSHClient, payload: bytes, remote_path: str, mode: str = "600") -> None:
    command = f"cat > {remote_path} && chmod {mode} {remote_path}"
    stdin, stdout, stderr = client.exec_command(command, timeout=180)
    channel = stdin.channel
    for offset in range(0, len(payload), 8192):
        chunk = payload[offset : offset + 8192]
        sent = 0
        while sent < len(chunk):
            sent += channel.send(chunk[sent:])
        time.sleep(0.005)
    stdin.channel.shutdown_write()
    exit_code = stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    if exit_code != 0:
        raise RuntimeError(f"remote upload failed ({exit_code}): {err}\n{out}")


def ensure_node(client: paramiko.SSHClient) -> None:
    result = run(client, "command -v node >/dev/null 2>&1 && node -v || true").strip()
    if result.startswith("v"):
        print(f"node detected: {result}")
        print(run(client, "npm -v"))
        return

    run(client, "apt-get update")
    run(client, "apt-get install -y ca-certificates curl gnupg")
    run(client, "mkdir -p /etc/apt/keyrings")
    run(client, "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg")
    run(client, "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list")
    run(client, "apt-get update")
    run(client, "apt-get install -y nodejs")
    print(run(client, "node -v && npm -v"))


def install_service(client: paramiko.SSHClient) -> None:
    service = f"""[Unit]
Description=Suoha Polymarket Sports Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={REMOTE_ROOT}
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
"""
    remote_path = f"/etc/systemd/system/{SERVICE_NAME}.service"
    upload_bytes(client, service.encode("utf-8"), remote_path, "644")


def run(client: paramiko.SSHClient, command: str) -> str:
    stdin, stdout, stderr = client.exec_command(command, timeout=180)
    stdin.close()
    exit_code = stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    if exit_code != 0:
        raise RuntimeError(f"remote command failed ({exit_code}): {command}\n{err}\n{out}")
    return out if out else err


if __name__ == "__main__":
    main()
