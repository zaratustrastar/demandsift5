#!/usr/bin/env python3
"""Production operator actions for DemandSift.

Driven by ops/request.json so a production operation is a data commit rather
than a new workflow. Everything printed here is published back to the PR,
because job logs on this repository are not retrievable.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from typing import Any

APP_URL = os.environ.get("APP_URL", "").rstrip("/")
REQUEST_PATH = "ops/request.json"

opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(CookieJar())
)


def call(method: str, path: str, body: dict | None = None, timeout: int = 60) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        f"{APP_URL}{path}",
        data=data,
        method=method,
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        status = error.code
    except Exception as error:  # network-level failure
        return 0, {"error": repr(error)}
    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, {"_raw": raw[:2000]}


def show(label: str, value: Any, limit: int = 4000) -> None:
    print(f"\n===== {label} =====")
    text = value if isinstance(value, str) else json.dumps(value, indent=1, default=str)
    print(text[:limit])


def funnel(report: dict) -> None:
    """Print the acceptance funnel from whatever the report exposes."""
    evidence = report.get("scanEvidence") or {}
    diagnostics = evidence.get("diagnostics") or report.get("diagnostics") or {}
    show("diagnostics", diagnostics, 6000)
    show("qualificationCoverage", report.get("qualificationCoverage"), 1500)
    print("\n----- output counts -----")
    print("relevantConversations:", len(report.get("relevantConversations") or []))
    print("opportunities        :", len(report.get("opportunities") or []))
    print("replies              :", len(report.get("replies") or []))
    print("conversationThemes   :", len(report.get("conversationThemes") or []))
    print("insights             :", len(report.get("insights") or []))
    print("potentialCustomers   :", (report.get("potentialCustomers") or {}).get("total"))
    print("storedCounts         :", json.dumps(report.get("storedCounts") or {}))


def poll_scan(scan_id: str, budget_seconds: int) -> str:
    """Poll to a terminal state, printing stage transitions as they happen."""
    deadline = time.time() + budget_seconds
    last = None
    started = time.time()
    while time.time() < deadline:
        status_code, payload = call("GET", f"/api/scans/{scan_id}?statusOnly=1")
        scan = (payload or {}).get("scan") or {}
        status = scan.get("status")
        stages = [
            f"{s.get('id')}={s.get('status')}"
            for s in (scan.get("progress") or [])
            if s.get("status") in ("active", "failed")
        ]
        snapshot = f"{status} | {' '.join(stages)}"
        if snapshot != last:
            print(f"[{int(time.time() - started):5d}s] http={status_code} {snapshot}")
            last = snapshot
        if status in ("complete", "failed"):
            return status
        time.sleep(10)
    return "timeout"


def main() -> None:
    request = json.load(open(REQUEST_PATH))
    print("request_id:", request.get("id"))
    print("app_url   :", APP_URL)
    print("utc_now   :", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    # Establish a workspace cookie for every subsequent call.
    code, _ = call("GET", "/api/scans/latest")
    print("session_bootstrap_http:", code)

    for scan_id in request.get("inspectScans", []):
        status_code, payload = call("GET", f"/api/scans/{scan_id}")
        scan = (payload or {}).get("scan") or {}
        print(f"\n########## scan {scan_id} (http {status_code}) ##########")
        print("status    :", scan.get("status"))
        print("createdAt :", scan.get("createdAt"))
        print("updatedAt :", scan.get("updatedAt"))
        print("error     :", scan.get("error"))
        for stage in scan.get("progress") or []:
            print(f"  stage {stage.get('id'):<16} {stage.get('status'):<9} {str(stage.get('detail'))[:130]}")
        report = (payload or {}).get("report")
        if report:
            funnel(report)

    scan_request = request.get("startScan")
    if scan_request:
        website = scan_request.get("websiteUrl", "https://tvcp.app")
        budget = int(scan_request.get("pollSeconds", 1800))
        print(f"\n########## starting scan for {website} ##########")
        code, created = call("POST", "/api/scans", {"websiteUrl": website, "defer": True})
        scan = (created or {}).get("scan") or {}
        scan_id = scan.get("id")
        print("create_http:", code, "scan_id:", scan_id)
        if not scan_id:
            show("create_response", created)
            return
        print("claimed_at :", scan.get("createdAt"))
        terminal = poll_scan(scan_id, budget)
        print("terminal_state:", terminal)

        status_code, payload = call("GET", f"/api/scans/{scan_id}")
        final = (payload or {}).get("scan") or {}
        print("final_status:", final.get("status"))
        print("finished_at :", final.get("updatedAt"))
        print("error       :", final.get("error"))
        for stage in final.get("progress") or []:
            print(f"  stage {stage.get('id'):<16} {stage.get('status'):<9} {str(stage.get('detail'))[:150]}")
        report = (payload or {}).get("report")
        if report:
            funnel(report)


if __name__ == "__main__":
    main()
