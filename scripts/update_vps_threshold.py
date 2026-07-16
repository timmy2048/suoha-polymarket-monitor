from __future__ import annotations

import os
import time

import paramiko


REMOTE_ROOT = "/opt/suoha-polymarket-monitor"
SERVICE_NAME = "suoha-polymarket-monitor"


def main() -> None:
    threshold = os.environ.get("THRESHOLD_USDC", "500000")
    host = require_env("VPS_HOST")
    username = os.environ.get("VPS_USER", "root")
    password = require_env("VPS_PASSWORD")
    port = int(os.environ.get("VPS_PORT", "22"))

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=host, port=port, username=username, password=password, timeout=20)

    try:
        timestamp = time.strftime("%Y%m%d%H%M%S")
        env_path = f"{REMOTE_ROOT}/.env"
        run(client, f"cp {env_path} {env_path}.bak.{timestamp}")
        run(
            client,
            f"grep -q '^THRESHOLD_USDC=' {env_path} "
            f"&& sed -i 's/^THRESHOLD_USDC=.*/THRESHOLD_USDC={threshold}/' {env_path} "
            f"|| printf '\\nTHRESHOLD_USDC={threshold}\\n' >> {env_path}"
        )
        print(run(client, f"grep '^THRESHOLD_USDC=' {env_path}"))
        run(client, f"systemctl restart {SERVICE_NAME}.service")
        print(run(client, f"systemctl is-active {SERVICE_NAME}.service"))
        print(run(client, f"journalctl -u {SERVICE_NAME}.service -n 20 --no-pager"))
    finally:
        client.close()


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def run(client: paramiko.SSHClient, command: str) -> str:
    stdin, stdout, stderr = client.exec_command(command, timeout=120)
    stdin.close()
    exit_code = stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    if exit_code != 0:
        raise RuntimeError(f"remote command failed ({exit_code}): {command}\n{err}\n{out}")
    return out if out else err


if __name__ == "__main__":
    main()
