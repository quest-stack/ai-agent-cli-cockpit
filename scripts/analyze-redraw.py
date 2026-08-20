"""表示崩れの発生頻度を診断ログから実測する。

対策（予防的自動再描画）の効果測定に使う。対策の前後で同じ指標を出し、
「利用者が手動 Ctrl+Shift+R を押した回数」が減ったかを見る。

使い方:
    python scripts/analyze-redraw.py [ログのパス]

既定のログ: %APPDATA%\\claude-cli-cockpit\\diagnostic.log

見るべき指標:
    手動回復イベント  … 利用者が崩れに気づいて自力で直した回数。これが 0 に
                        近づくのが対策の目標。予防実行が効けば減る。
    予防実行           … 対策が実際に走った回数（v0.1.7 以降のみ記録される）。
    崩れ頻度           … 稼働時間あたりの手動回復回数。対策前は 1.26 回/時間だった。
"""

from __future__ import annotations

import collections
import json
import os
import re
import sys
from datetime import datetime

LINE = re.compile(r"^(\S+) \[(\w+)\] (\S+) (\{.*\})\s*$")

# 5 秒以内に連続する redraw は「1 回の崩れへの対処」とみなす。
# 追い打ち再描画（300ms）と利用者の連打を 1 件に束ねるため。
SAME_INCIDENT_WINDOW_SEC = 5.0

# 5 分以上ログが途切れたらアプリが動いていなかったとみなす（稼働時間の推定用）。
IDLE_GAP_SEC = 300


def default_log_path() -> str:
    appdata = os.environ.get("APPDATA", "")
    return os.path.join(appdata, "claude-cli-cockpit", "diagnostic.log")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    path = sys.argv[1] if len(sys.argv) > 1 else default_log_path()
    if not os.path.exists(path):
        print(f"ログが見つかりません: {path}")
        return 1

    rows: list[tuple[datetime, str, str]] = []
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            match = LINE.match(line.rstrip("\n"))
            if not match:
                continue
            timestamp, _source, category, payload = match.groups()
            try:
                moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            except ValueError:
                continue
            rows.append((moment, category, payload))

    if not rows:
        print("解析できる行がありませんでした。")
        return 1

    rows.sort(key=lambda row: row[0])

    events = collections.Counter()
    manual_times: list[datetime] = []
    for moment, category, payload in rows:
        if category != "terminal.webgl":
            continue
        try:
            fields = json.loads(payload)
        except json.JSONDecodeError:
            continue
        event = fields.get("event", "")
        events[event] += 1
        # 予防実行は自動なので、手動回復の集計からは除く。
        if event == "redraw":
            manual_times.append(moment)

    incidents: list[datetime] = []
    for moment in manual_times:
        if incidents and (moment - incidents[-1]).total_seconds() <= SAME_INCIDENT_WINDOW_SEC:
            continue
        incidents.append(moment)

    runs: list[list[datetime]] = []
    for moment, _category, _payload in rows:
        if runs and (moment - runs[-1][1]).total_seconds() <= IDLE_GAP_SEC:
            runs[-1][1] = moment
        else:
            runs.append([moment, moment])
    uptime_sec = sum((end - start).total_seconds() for start, end in runs)

    span_start = rows[0][0].astimezone()
    span_end = rows[-1][0].astimezone()
    print(f"対象ログ: {path}")
    print(f"期間: {span_start:%m/%d %H:%M} 〜 {span_end:%m/%d %H:%M}")
    print(f"推定稼働: {uptime_sec / 3600:.1f} 時間\n")

    print(f"手動回復イベント: {len(incidents)} 回")
    if uptime_sec > 0 and incidents:
        per_hour = len(incidents) / (uptime_sec / 3600)
        print(f"  崩れ頻度: {per_hour:.2f} 回/時間（平均 {uptime_sec / 60 / len(incidents):.0f} 分に 1 回）")
        print("  ※ 対策前（2026-08-16 実測・v0.1.6）は 1.26 回/時間 = 47 分に 1 回")

    print("\n=== イベント別 ===")
    for event, count in events.most_common():
        label = event or "(なし)"
        print(f"  {count:>6}  {label}")

    by_day = collections.Counter(moment.astimezone().strftime("%m/%d") for moment in incidents)
    if by_day:
        print("\n=== 日別の手動回復回数 ===")
        for day, count in sorted(by_day.items()):
            print(f"  {day}  {'#' * count} {count}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
