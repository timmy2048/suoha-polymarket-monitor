from __future__ import annotations

import os

import paramiko


REMOTE_ROOT = "/opt/suoha-polymarket-monitor"
SERVICE_NAME = "suoha-polymarket-monitor"


def main() -> None:
    host = require_env("VPS_HOST")
    username = os.environ.get("VPS_USER", "root")
    password = require_env("VPS_PASSWORD")
    port = int(os.environ.get("VPS_PORT", "22"))

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=host, port=port, username=username, password=password, timeout=20)
    try:
        print(run(client, f"systemctl is-active {SERVICE_NAME}.service"))
        print(run(client, f"journalctl -u {SERVICE_NAME}.service -n 50 --no-pager"))
        print(
            run(
                client,
                f"cd {REMOTE_ROOT} && grep -E '^(THRESHOLD_USDC|LARGE_TRADE_THRESHOLD_USDC|LARGE_TRADE_MIN_CANDIDATE_USDC|LARGE_TRADE_CUMULATIVE_WINDOW_SECONDS|LARGE_TRADE_POLL_INTERVAL_SECONDS|WATCHLIST_FILE|ADDRESS_MONITOR_ENABLED|ADDRESS_POLL_INTERVAL_SECONDS|ADDRESS_AGGREGATION_WINDOW_SECONDS|ADDRESS_SPORTS_SCOPE_PATHS|SPORTS_CATALOG_REFRESH_SECONDS|HOLDER_POLL_INTERVAL_SECONDS|PREMATCH_MONITOR_MINUTES|MATCH_MONITOR_DURATION_MINUTES|SCHEDULE_REFRESH_TIME_LOCAL)=' .env"
            )
        )
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
