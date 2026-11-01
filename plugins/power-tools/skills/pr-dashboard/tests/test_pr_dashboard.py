"""Tests for pr_dashboard.py (stdlib unittest). Run: python -I -m unittest discover -s tests -v
(from the skill folder) or python -I tests/test_pr_dashboard.py."""
from __future__ import annotations

import copy
import importlib.util
import io
import itertools
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "pr_dashboard.py"
FIX = HERE / "fixtures"
_spec = importlib.util.spec_from_file_location("pr_dashboard", SCRIPT)
ghs = importlib.util.module_from_spec(_spec)
sys.modules["pr_dashboard"] = ghs
_spec.loader.exec_module(ghs)

with open(FIX / "snapshot_raw.json", encoding="utf-8") as _fh:
    RAW = json.load(_fh)
with open(FIX / "state2_v2.json", encoding="utf-8") as _fh:
    V2 = json.load(_fh)
NOW = datetime.fromisoformat(RAW["now"]).timestamp()
NOW_DT = datetime.fromtimestamp(NOW, timezone.utc)
PEERS = ["widgets-12", "widgets-b2", "widgets-b4", "widgets-c6", "widgets-f1",
         "widgets-ee", "fleet status reply", "auth-admin-tools"]

GOOD = {
    "one_line": "main is red: fix it before #144 and #145 test on it; #93 can merge",
    "merge_order": [93, 144, 145, 143, 139, 80, 77],
    "pr_notes": [{"pr": 145, "note": "still pushing"}, {"pr": 139, "note": "sources closed; b2 waits"},
                 {"pr": 81, "note": "superseded"}],
    "contradictions": [{"pr": 143, "session": "widgets-12", "claim": "CI running"}],
    "needs_you": [
        {"verb": "fix", "prs": [], "main": True, "text": "Fix main d5ce95a before the queue tests on it"},
        {"verb": "answer", "prs": [143], "main": False, "text": "Answer 12: #143 is queued, not running"},
        {"verb": "reorder", "prs": [145, 143], "main": False, "text": "Reorder: f1 is still pushing #145, so promote #143"},
        {"verb": "merge", "prs": [93], "main": False, "text": "Merge #93, or rerun it first: its green is old"},
        {"verb": "answer", "prs": [110, 134], "main": False, "text": "Answer b2 on #110 R2.1 naming and c6 on #134 design"},
        {"verb": "assign", "prs": [139, 80, 77], "main": False, "text": "Assign or close #139 #80 #77: all conflict"},
    ],
    "labels": [{"pr": 93, "label": "cloud DR docs"}, {"pr": 144, "label": "#129 follow-up"},
               {"pr": 145, "label": "email review round"}, {"pr": 143, "label": "combined Oct16"},
               {"pr": 139, "label": "CI test hygiene"}, {"pr": 80, "label": "api/v1 foundation"},
               {"pr": 77, "label": "Tauri shell"}, {"pr": 81, "label": "client SPA"}, {"pr": 82, "label": "mobile app"},
               {"pr": 109, "label": "platform vision"}, {"pr": 110, "label": "platform impl plan"},
               {"pr": 134, "label": "inbox structure"}],
}


class Clock:
    def __init__(self, start=NOW):
        self.start, self.m0 = start, time.monotonic()

    def __call__(self):
        return self.start + (time.monotonic() - self.m0)


class FakeFetch:
    """Serves the real snapshot instead of gh. `claude_fn(digest)` returns (raw, cost) or raises."""

    def __init__(self, raw=None, status_dir=None, claude_fn=None, delays=None, fail=(), claims=None):
        self.raw = copy.deepcopy(raw or RAW)
        self.sd = Path(status_dir) if status_dir else Path(tempfile.mkdtemp())
        self.claude_fn = claude_fn
        self.delays = delays or {}
        self.fail = set(fail)
        self.calls: list[str] = []
        self.digests: list[dict] = []
        self._claims = claims or []
        self.lock = threading.Lock()

    def _hit(self, name):
        with self.lock:
            self.calls.append(name)
        if name in self.delays:
            time.sleep(self.delays[name])
        if name in self.fail:
            raise ghs.GhError("other", f"{name} failed")

    def repo(self):
        return self.raw["repo"]

    def workflow(self):
        return self.raw["workflow"]

    def prs(self, repo, wf):
        self._hit("prs")
        return copy.deepcopy(self.raw["prs"])

    def ci_runs(self, repo, wf):
        self._hit("ci_runs")
        return copy.deepcopy(self.raw["ci_runs"])

    def recent(self, repo):
        self._hit("recent")
        return copy.deepcopy(self.raw["recent"])

    def jobs(self, repo, rid):
        self._hit("jobs")
        self._hit(f"jobs:{rid}")
        return copy.deepcopy(self.raw["jobs"].get(str(rid), []))

    def commit_members(self, repo, n):
        self._hit("members")
        return []

    def closed(self, repo, n):
        self._hit("closed")
        return dict(self.raw["closed"].get(str(n), {}))

    def qlabel(self, repo):
        self._hit("qlabel")
        return self.raw["qlabel"]

    def codex(self, now):
        self._hit("codex")
        return []

    def claims(self):
        self._hit("claims")
        return list(self._claims)

    def status_dir(self):
        return self.sd

    def claude(self, digest):
        self._hit("claude")
        self.digests.append(digest)
        if self.claude_fn is None:
            raise ghs.ClaudeError("no fake")
        return self.claude_fn(digest)


def good_claude(digest):
    return copy.deepcopy(GOOD), 0.0004


def peer_dir(offsets=None, names=None) -> Path:
    """Copy the real peer files into a temp dir, mtimes set to NOW - offset seconds."""
    d = Path(tempfile.mkdtemp(prefix="ghs-peers-"))
    for f in (FIX / "peers").glob("*.txt"):
        if names is not None and f.stem not in names:
            continue
        shutil.copy(f, d / f.name)
        off = (offsets or {}).get(f.stem, 20)
        os.utime(d / f.name, (NOW - off, NOW - off))
    return d


def args_for(argv):
    args, views = ghs.parse_args(argv)
    return args, views


def run(argv, fetch=None, clock=None, term=None):
    args, views = args_for(argv)
    fetch = fetch or FakeFetch(claude_fn=good_claude)
    caches = ghs.Caches(disk=False)
    rc, lines, orch = ghs.run_once(args, views, caches, fetch, term, now_fn=clock or Clock())
    return rc, lines, orch


def text(argv, **kw):
    return run(argv + ["--format", "text"], **kw)


def asked(extra=(), offsets=None, names=None, claude_fn=good_claude, **kw):
    """The skill's invocation: peers asked 70 s ago (all files present, so no wait)."""
    sd = peer_dir(offsets, names)
    fetch = FakeFetch(status_dir=sd, claude_fn=claude_fn, **kw)
    argv = ["--peers-since", str(NOW - 70), "--peers", ",".join(PEERS), "--self", "widgets-c7",
            "--peer-timeout", "60", *extra]
    return argv, fetch


def check_text_frame(tc, lines):
    for l in lines:
        tc.assertLessEqual(len(l), 90, l)
        tc.assertTrue(all(32 <= ord(c) < 127 for c in l), repr(l))
        tc.assertNotIn("\x1b", l)


_TMP_CACHE = Path(tempfile.mkdtemp(prefix="pr-dashboard-cache-"))


def setUpModule():
    # main() loads and saves the disk caches; keep fixture data out of the real ones.
    ghs.CACHE_FILE = _TMP_CACHE / "cache.json"
    ghs.SHAPE_FILE = _TMP_CACHE / "last.json"


# ======================================================================== tests
class ViewParsing(unittest.TestCase):
    def test_flags_and_words(self):
        cases = {
            (): ghs.ALL_VIEWS, ("--one-line",): {"line"}, ("line",): {"line"}, ("1",): {"line"},
            ("--prs", "--actions"): {"prs", "actions"}, ("prs", "actions"): {"prs", "actions"},
            ("all",): ghs.ALL_VIEWS, ("full",): ghs.ALL_VIEWS, ("--prs", "all"): ghs.ALL_VIEWS,
            ("--one-line", "--prs", "--actions"): ghs.ALL_VIEWS, ("--actions",): {"actions"},
        }
        for argv, want in cases.items():
            _, views = ghs.parse_args(list(argv))
            self.assertEqual(views, frozenset(want), argv)

    def test_quick_pr_watch(self):
        a, v = ghs.parse_args(["quick"])
        self.assertTrue(a.no_peers)
        self.assertEqual(v, ghs.ALL_VIEWS)
        a, v = ghs.parse_args(["pr", "143"])
        self.assertEqual(a.pr, 143)
        a, _ = ghs.parse_args(["watch"])
        self.assertEqual(a.watch, 60)
        a, _ = ghs.parse_args(["--watch", "5"])
        self.assertEqual(a.watch, 20)   # clamped to protect the gh rate limit
        a, _ = ghs.parse_args(["--prs", "--format", "md"])
        self.assertEqual(a.format, "md")

    def test_unknown_word_prints_one_usage_line(self):
        out = io.StringIO()
        rc = ghs.main(["bogus"], out=out)
        self.assertEqual(rc, 2)
        self.assertEqual(out.getvalue().count("\n"), 1)
        self.assertTrue(out.getvalue().startswith("usage:"))
        out = io.StringIO()
        self.assertEqual(ghs.main(["--nope"], out=out), 2)
        self.assertEqual(out.getvalue().count("\n"), 1)


class Sanitize(unittest.TestCase):
    def test_controls_and_escapes_removed(self):
        evil = "PR \x1b[2J\x1b]52;c;ZXZpbA==\x07title\x1b]8;;http://x\x1b\\link\x9b31m\x00\x07 end"
        out = ghs.clean(evil)
        self.assertNotIn("\x1b", out)
        self.assertTrue(all(32 <= ord(c) < 127 for c in out))
        self.assertIn("title", out)
        self.assertNotIn("52;c", out)

    def test_ascii_fold(self):
        self.assertEqual(ghs.clean("Mobile Application \u2014 caf\u00e9 \u201cx\u201d \u2026"), 'Mobile Application - cafe "x" ...')
        self.assertEqual(ghs.clean("\u6f22\u5b57"), "??")
        self.assertEqual(ghs.clean(None), "")

    def test_cut(self):
        self.assertEqual(ghs.cut("abcdefghij", 6), "abcd..")
        self.assertLessEqual(len(ghs.cut_words("one two three four five six", 12)), 12)


class PeerFiles(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())

    def write(self, name, data: bytes, age=10):
        p = self.d / name
        p.write_bytes(data)
        os.utime(p, (NOW - age, NOW - age))
        return p

    def test_real_files_parse(self):
        lines = ghs.scan_peers(peer_dir(), NOW - 70, NOW)
        self.assertEqual(len(lines), 7)
        b2 = lines["widgets-b2"]
        self.assertTrue(b2.fresh)
        self.assertEqual(b2.fields["ask"], "R2.1 naming in #110 (extend ItemCategory or new table)")
        self.assertEqual(ghs.refs_outside_parens(b2.fields["prs"]), [109, 110, 134, 82])
        self.assertIn("fleet status reply", lines)

    def test_empty_bom_crlf_binary_big(self):
        self.write("empty.txt", b"")
        self.write("bom.txt", "\ufeffa | #1 | doing | waiting on - | next push none | ask owner - | ETA -\r\n".encode("utf-8"))
        self.write("bin.txt", bytes(range(256)) * 8)
        self.write("big.txt", b"x | #2 | y | w | n | a | e\n" + b"z" * 1_000_000)
        self.write("raw.txt", b"just prose, no pipes at all\n")
        self.write("pipes.txt", b"n | #3 | a | b | c | d | e | f | g\n")
        lines = ghs.scan_peers(self.d, NOW - 70, NOW)
        self.assertTrue(lines["empty"].empty)
        self.assertEqual(lines["bom"].fields["name"], "a")
        self.assertEqual(lines["bom"].fields["ask"], "-")
        self.assertTrue(all(32 <= ord(c) < 127 for c in lines["bin"].raw))
        self.assertEqual(lines["big"].fields["prs"], "#2")
        self.assertIsNone(lines["raw"].fields)
        self.assertEqual(lines["raw"].raw, "just prose, no pipes at all")
        self.assertEqual(lines["pipes"].fields["eta"], "e | f | g")

    def test_old_and_stale(self):
        self.write("old.txt", b"o | #1 | a | b | c | d | e", age=200)
        self.write("ancient.txt", b"o | #1 | a | b | c | d | e", age=31 * 60)
        lines = ghs.scan_peers(self.d, NOW - 70, NOW)
        self.assertFalse(lines["old"].fresh)
        self.assertNotIn("ancient", lines)

    def test_escape_in_peer_line_stripped(self):
        self.write("evil.txt", b"evil | #93 | \x1b[2Jwipe\x1b]0;title\x07 | - | - | - | -")
        pl = ghs.scan_peers(self.d, NOW - 70, NOW)["evil"]
        self.assertNotIn("\x1b", pl.raw)
        self.assertEqual(pl.fields["doing"], "wipe")

    def test_directory_and_marker_skipped(self):
        (self.d / "dir.txt").mkdir()
        self.write("_request.txt", b"x")
        self.assertEqual(ghs.scan_peers(self.d, NOW - 70, NOW), {})


class Derivation(unittest.TestCase):
    def setUp(self):
        _, _, self.orch = run(["--no-claude", "--no-peers", "--format", "text"])
        self.board, self.people = self.orch.snapshot(NOW)

    def test_v2_parity(self):
        b = self.board
        self.assertEqual(b["queue"], V2["queue_predicted"])
        self.assertEqual(ghs.mins(b["typical"]), V2["typical_ci"])
        rows = b["rows"]
        for p in V2["prs"]:
            r = rows[p["number"]]
            self.assertEqual(r["state"], p["state"], p["number"])
            self.assertEqual(r["eta"], p["eta"], p["number"])
            self.assertEqual(r["why_not"], p["not_queued_because"], p["number"])
            self.assertEqual(r["members"], p["members"], p["number"])
        m = b["main"]
        self.assertEqual((m["verdict"], m["overrun"], m["done"], m["total"]), ("failing", True, 13, 14))

    def test_tokens(self):
        r = self.board["rows"]
        self.assertEqual(self.board["tree"], [93, 144, 145, 143, 139, 80, 77])
        self.assertEqual([r[n]["token"] for n in self.board["tree"]], ["ready", "q1", "q2", "q3", "CONFLICT", "CONFLICT", "CONFLICT"])
        self.assertEqual(ghs.ci_strip(self.board["main"]), "..3.56.8")
        self.assertEqual(r[77]["ci"], "..3.")
        self.assertEqual(r[93]["ci"], "....")
        self.assertEqual([r[n]["eta_tok"] for n in (93, 144, 145, 143)], ["now", "~33m", "~1h06m", "~1h39m"])
        self.assertEqual(r[139]["fact_note"], "sources closed")
        self.assertEqual(r[93]["fact_note"], "last run 107h ago")
        self.assertEqual(self.board["drafts"], [81, 82, 109, 110, 134])

    def test_people_asked(self):
        argv, fetch = asked(["--no-claude", "--format", "text"])
        _, _, orch = run(argv, fetch=fetch)
        b, p = orch.snapshot(NOW)
        self.assertEqual(p["who"][144], "c6")
        self.assertEqual(p["who"][145], "f1")
        self.assertEqual(p["who"][77], "(36)")       # title owner, not a live session
        self.assertEqual(p["who"][134], "b2+c6")
        self.assertEqual(p["contra"], {143: "! 12 says CI running"})
        self.assertEqual(p["push"], {145: "still pushing"})
        self.assertEqual(p["silent"], ["ee"])
        self.assertEqual(sorted(p["idle"]), ["b4", "fleet"])   # long names cut at the first word
        self.assertEqual(p["other"], ["auth #887"])
        self.assertEqual(len(p["replied"]), 7)


class ClaudeValidation(unittest.TestCase):
    def setUp(self):
        argv, fetch = asked(["--no-claude", "--format", "text"])
        _, _, orch = run(argv, fetch=fetch)
        self.board, self.people = orch.snapshot(NOW)
        self.digest = ghs.digest_for_claude(self.board, self.people, "widgets-c7")

    def v(self, **over):
        raw = copy.deepcopy(GOOD)
        raw.update(over)
        return ghs.validate_fill(raw, self.board, self.people, self.digest)

    def test_good(self):
        f = self.v()
        self.assertEqual(f.order_source, "claude")
        self.assertEqual(len(f.needs), 6)
        self.assertEqual(f.contra[143], "! 12 says CI running")
        self.assertEqual(f.labels[93], "cloud DR docs")
        self.assertEqual(f.rejected, [])

    def test_bad_merge_order_falls_back(self):
        f = self.v(merge_order=[144, 93, 999, 144])            # missing PRs, unknown 999, dup
        self.assertEqual(f.order_source, "default")
        self.assertEqual(f.merge_order, self.board["tree"])
        f = self.v(merge_order=[93, 144, 145, 143, 139, 80, 77, 81, 1234])   # draft + unknown dropped
        self.assertEqual(f.order_source, "claude")
        self.assertEqual(f.merge_order, [93, 144, 145, 143, 139, 80, 77])

    def test_unknown_pr_refs_dropped(self):
        f = self.v(needs_you=[{"verb": "merge", "prs": [999], "main": False, "text": "Merge #999 now"},
                              {"verb": "merge", "prs": [93], "main": False, "text": "Merge #93 and #4242"},
                              {"verb": "close", "prs": [139], "main": False, "text": "Close #139"}],
                   pr_notes=[{"pr": 5555, "note": "ghost"}])
        self.assertEqual([n["text"] for n in f.needs if not n["main"]], ["Close #139"])
        self.assertNotIn(5555, f.notes)

    def test_digits_rejected_unless_copied(self):
        f = self.v(one_line="main failed 4 shards and 3 PRs wait", labels=[{"pr": 145, "label": "email review r9"}],
                   pr_notes=[{"pr": 93, "note": "green 107h ago"}, {"pr": 144, "note": "c6 owns it"}])
        self.assertIsNone(f.one_line)
        self.assertNotIn(145, f.labels)
        self.assertNotIn(93, f.notes)                   # numbers belong to code, not Claude
        self.assertEqual(f.notes[144], "c6 owns it")    # 'c6' is copied from the data
        f = self.v(needs_you=[{"verb": "answer", "prs": [110], "main": False, "text": "Answer b2: R2.1 naming"}])
        self.assertEqual(f.needs[-1]["text"], "Answer b2: R2.1 naming")

    def test_red_main_ask_restored_by_code(self):
        f = self.v(needs_you=[{"verb": "fix", "prs": [], "main": True, "text": "Fix main: shards 3,5,6,8 failed"},
                              {"verb": "close", "prs": [139], "main": False, "text": "Close #139"}])
        self.assertEqual(f.needs[0]["text"], "Fix main d5ce95a: shards 3 5 6 8 failed; 20m past the typical 33m")
        self.assertTrue(f.needs[0]["main"])
        self.assertEqual(f.needs[1]["text"], "Close #139")

    def test_ci_percent_not_copyable(self):
        b = copy.deepcopy(self.board)
        d = ghs.digest_for_claude(b, self.people, "widgets-c7")
        d["prs"][0].update({"state": "CI running", "ci_pct": "35%"})
        f = ghs.validate_fill(dict(GOOD, pr_notes=[{"pr": 93, "note": "CI at 35%"}]), b, self.people, d)
        self.assertNotIn(93, f.notes)

    def test_number_words_rejected(self):
        f = self.v(one_line="main failed four shards; fix it first",
                   pr_notes=[{"pr": 143, "note": "close five after merge"}, {"pr": 80, "note": "rebase first"}])
        self.assertIsNone(f.one_line)
        self.assertNotIn(143, f.notes)
        self.assertEqual(f.notes[80], "rebase first")   # ordinals are fine

    def test_labels_needed_and_schema_sent_loose(self):
        self.assertEqual(self.digest["labels_needed"], self.board["tree"] + self.board["drafts"])
        cache = {ghs.title_key(self.board["rows"][93]["raw_title"]): (NOW, "cloud DR docs")}
        d = ghs.digest_for_claude(self.board, self.people, "widgets-c7", cache)
        self.assertNotIn(93, d["labels_needed"])
        self.assertEqual(ghs.material_key(d, "m"), ghs.material_key(self.digest, "m"))
        self.assertNotIn("maxLength", ghs.SCHEMA_JSON)    # limits are enforced here, not by retries
        self.assertIn("maxLength", json.dumps(ghs.SCHEMA))

    def test_overlong_truncated_and_ascii(self):
        f = self.v(one_line="caf\u00e9 \x1b[31m" + "word " * 40,
                   labels=[{"pr": 93, "label": "a very long label that goes on"}],
                   needs_you=[{"verb": "fix", "prs": [], "main": True, "text": "fix main " + "now " * 40}])
        self.assertLessEqual(len(f.one_line), 120)
        self.assertTrue(f.one_line.startswith("cafe "))
        self.assertLessEqual(len(f.labels[93]), 40)
        self.assertLessEqual(len(f.needs[0]["text"]), 120)

    def test_bad_types_and_verbs(self):
        with self.assertRaises(ghs.ClaudeError):
            ghs.validate_fill(["not", "a", "dict"], self.board, self.people, self.digest)
        f = self.v(needs_you=[{"verb": "deploy", "prs": [], "main": False, "text": "deploy prod"}, "junk"],
                   merge_order="nope", labels=None, pr_notes=[{"pr": 93}])
        self.assertEqual(f.order_source, "default")
        self.assertEqual(f.needs_from, "rules")          # all Claude items rejected -> rules
        self.assertTrue(f.needs[0]["text"].startswith("Fix main d5ce95a: shards 3 5 6 8 failed"))

    def test_cache_key_ignores_volatile(self):
        k1 = ghs.material_key(self.digest, "m")
        d2 = copy.deepcopy(self.digest)
        d2["main"]["elapsed"] = "59m"
        for p in d2["prs"]:
            p["eta"] = "~1m"
        for p in d2["peers"]:
            p["age"] = "9m"
        self.assertEqual(ghs.material_key(d2, "m"), k1)
        d2["prs"][0]["mergeable"] = "CONFLICTING"
        self.assertNotEqual(ghs.material_key(d2, "m"), k1)
        self.assertNotEqual(ghs.material_key(self.digest, "other-model"), k1)


FAKE_CLAUDE = r'''
import json, os, sys, time
mode = os.environ.get("FAKE_MODE", "ok")
rec = os.environ.get("FAKE_RECORD")
data = sys.stdin.buffer.read()
if rec:
    with open(rec, "w", encoding="utf-8") as fh:
        json.dump({"argv": sys.argv[1:], "stdin": data.decode("utf-8"), "cwd": os.getcwd(),
                   "depth": os.environ.get("PR_DASHBOARD_DEPTH")}, fh)
if mode == "sleep":
    time.sleep(30)
if mode == "is_error":
    print(json.dumps({"type": "result", "is_error": True, "subtype": "error_during_execution", "result": "boom"}))
elif mode == "garbage":
    print("this is not json {")
elif mode == "auth":
    print("Not logged in. Please run /login", file=sys.stderr); sys.exit(1)
elif mode == "result_only":
    print(json.dumps({"type": "result", "is_error": False, "subtype": "success", "result": json.dumps({"one_line": "x"})}))
else:
    print(json.dumps({"type": "result", "is_error": False, "subtype": "success", "total_cost_usd": 0.0004,
                      "structured_output": {"one_line": "ok", "merge_order": []}}))
'''


class ClaudeProcess(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="ghs-fake-"))
        cls.fake = cls.dir / "fake_claude.py"
        cls.fake.write_text(FAKE_CLAUDE, encoding="utf-8")

    def setUp(self):
        self.env = {k: os.environ.get(k) for k in ("PR_DASHBOARD_CLAUDE_ARGV", "FAKE_MODE", "FAKE_RECORD", "PR_DASHBOARD_DEPTH")}
        os.environ["PR_DASHBOARD_CLAUDE_ARGV"] = json.dumps([sys.executable, "-I", str(self.fake)])
        os.environ.pop("PR_DASHBOARD_DEPTH", None)
        self.rec = self.dir / f"rec-{self._testMethodName}.json"
        os.environ["FAKE_RECORD"] = str(self.rec)

    def tearDown(self):
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def call(self, mode, timeout=10):
        os.environ["FAKE_MODE"] = mode
        return ghs.call_claude({"prs": [{"n": 93}], "note": "caf\u00e9"}, "claude-haiku-5-5", timeout)

    def test_ok_and_invocation_contract(self):
        raw, cost = self.call("ok")
        self.assertEqual(raw["one_line"], "ok")
        self.assertAlmostEqual(cost, 0.0004)
        rec = json.loads(self.rec.read_text(encoding="utf-8"))
        argv = rec["argv"]
        self.assertEqual(json.loads(rec["stdin"]), {"prs": [{"n": 93}], "note": "caf\u00e9"})
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "")
        for flag in ("-p", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config",
                     "--json-schema", "--system-prompt"):
            self.assertIn(flag, argv)
        self.assertNotIn("--bare", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "claude-haiku-5-5")
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertEqual(argv[argv.index("--max-budget-usd") + 1], "0.05")
        self.assertEqual(os.path.normcase(rec["cwd"]), os.path.normcase(str(ghs.CLAUDE_DIR)))
        self.assertEqual(rec["depth"], "1")

    def test_failures(self):
        for mode, reason in (("is_error", "api error"), ("garbage", "bad output"), ("auth", "not logged in")):
            with self.subTest(mode=mode):
                with self.assertRaises(ghs.ClaudeError) as cm:
                    self.call(mode)
                self.assertEqual(str(cm.exception), reason)
                self.assertLessEqual(len(str(cm.exception).split()), 6)

    def test_result_string_fallback(self):
        raw, _ = self.call("result_only")
        self.assertEqual(raw, {"one_line": "x"})

    def test_timeout_kills(self):
        t = time.monotonic()
        with self.assertRaises(ghs.ClaudeError) as cm:
            self.call("sleep", timeout=2)
        self.assertEqual(str(cm.exception), "timeout 2s")
        self.assertLess(time.monotonic() - t, 2 + 6)

    def test_recursion_guard(self):
        os.environ["PR_DASHBOARD_DEPTH"] = "1"
        if self.rec.exists():
            self.rec.unlink()
        with self.assertRaises(ghs.ClaudeError) as cm:
            self.call("ok")
        self.assertIn("nested", str(cm.exception))
        self.assertFalse(self.rec.exists())       # never spawned

    def test_recursion_guard_in_orchestrator(self):
        os.environ["PR_DASHBOARD_DEPTH"] = "1"
        fetch = FakeFetch(claude_fn=good_claude)
        rc, lines, orch = text(["--no-peers"], fetch=fetch)
        self.assertNotIn("claude", fetch.calls)
        self.assertIn("summary unavailable (nested call refused)", lines)

    def test_cmd_shim_refused(self):
        os.environ.pop("PR_DASHBOARD_CLAUDE_ARGV")
        old = os.environ.get("PR_DASHBOARD_CLAUDE")
        os.environ["PR_DASHBOARD_CLAUDE"] = r"C:\npm\claude.cmd"
        try:
            with self.assertRaises(ghs.ClaudeError) as cm:
                ghs.claude_argv("m")
            self.assertIn("cmd shim", str(cm.exception))
        finally:
            if old is None:
                os.environ.pop("PR_DASHBOARD_CLAUDE")
            else:
                os.environ["PR_DASHBOARD_CLAUDE"] = old


class RenderText(unittest.TestCase):
    VIEWS = [["--one-line"], ["--prs"], ["--actions"], ["--one-line", "--prs"], ["--one-line", "--actions"],
             ["--prs", "--actions"], []]

    def test_every_view_ascii_90(self):
        for v in self.VIEWS:
            with self.subTest(views=v):
                argv, fetch = asked(v + ["--format", "text"])
                rc, lines, _ = run(argv, fetch=fetch)
                self.assertEqual(rc, 0)
                check_text_frame(self, lines)
                self.assertTrue(lines[0].endswith(ghs.hhmm(NOW_DT)), lines[0])
                self.assertEqual(sum(1 for l in lines if re.search(r"\d\d:\d\dZ$", l)), 1)  # one time, line 1

    def test_one_line_alone(self):
        rc, lines, _ = text(["--one-line"])
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("RED  main is red"))
        self.assertEqual(len(lines[0]), 90)

    def test_default_golden(self):
        argv, fetch = asked(["--format", "text"])
        rc, lines, _ = run(argv, fetch=fetch)
        frame = "\n".join(lines)
        expect = [
            "RED  main is red: fix it before #144 and #145 test on it; #93 can merge; 6 asks",
            "    #     what               state     ci        eta    who   note",
            "main d5ce95a                 RED       ..3.56.8  over   -     quality job running [1]",
            "|-- #93   cloud DR docs      ready     ....      now    -     last run 107h ago [4]",
            "|-- #144  #129 follow-up     q1        -         ~33m   c6",
            "|-- #145  email review round q2        -         ~1h06m f1    still pushing [3]",
            "|-- #143  combined Oct16     q3        -         ~1h39m 12    ! 12 says CI running [2]",
            "|   `-- #132 #133 #135 #140 #142 folded in; close after #143 merges",
            "`-- #77   Tauri shell        CONFLICT  ..3.      -      (36)  last run 109h ago [6]",
            "drafts  #81 superseded   #82 (36)->b2   #109 #110 b2   #134 b2+c6",
            "runs    1 active (main, above)   3 queued, serial, ~33m each   codex 0",
            "peers   7/8 replied   idle b4 fleet   silent ee   other repo: auth #887",
            "Needs you",
            "1. Fix main d5ce95a before the queue tests on it",
            "6. Assign or close #139 #80 #77: all conflict",
        ]
        for e in expect:
            self.assertIn(e, frame)
        check_text_frame(self, lines)

    def test_actions_golden(self):
        rc, lines, orch = text(["--actions"])
        self.assertTrue(lines[0].startswith("ACTIONS  1 running   3 queued   serial, ~33m each   codex 0"))
        frame = "\n".join(lines)
        self.assertIn("~   38867130136  CI  main d5ce95a      13/14  ..3.56.8  53m ago   over    20m past typical", frame)
        self.assertIn("    `-- ~ Quality and integration checks", frame)
        self.assertIn("q1  #144         CI  fix/inbox-129-r.. -      -         next      ~33m", frame)
        self.assertIn("q3  #143         CI  feat/combined-o.. -      -         in ~1h06m ~1h39m", frame)
        fetch_calls = [c for c in orch.f.calls if c.startswith("jobs:")]
        self.assertEqual(fetch_calls, ["jobs:38867130136"])       # only the active run's jobs
        self.assertNotIn("claude", orch.f.calls)
        self.assertNotIn("claims", orch.f.calls)

    def test_claude_failure_fallback(self):
        def boom(d):
            raise ghs.ClaudeError("timeout 30s")
        argv, fetch = asked(["--format", "text"], claude_fn=boom)
        rc, lines, _ = run(argv, fetch=fetch)
        self.assertEqual(rc, 0)
        self.assertIn("claude unavailable", lines[0])
        self.assertIn("summary unavailable (timeout 30s)", lines)
        self.assertIn("1. Fix main d5ce95a: shards 3 5 6 8 failed; 20m past the typical 33m", lines)
        self.assertTrue(any(l.startswith("|-- #93   Complete cloud..") for l in lines))
        self.assertIn("(default order)", lines[2])

    def test_no_claude(self):
        rc, lines, orch = text(["--no-claude", "--no-peers"])
        self.assertNotIn("claude", orch.f.calls)
        self.assertNotIn("summary unavailable", "\n".join(lines))
        self.assertTrue(lines[0].startswith("RED  main red, 7 open, 3 queued, 5 draft, 3 conflict"))

    def test_gh_down(self):
        rc, lines, _ = text(["--no-peers"], fetch=FakeFetch(fail={"prs"}))
        self.assertEqual(rc, 1)
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("gh unavailable: prs failed"))

    def test_job_fetch_failure_shows_ci_question(self):
        fetch = FakeFetch(claude_fn=good_claude, fail={"jobs:38867130136"})
        rc, lines, _ = text(["--no-peers"], fetch=fetch)
        self.assertEqual(rc, 0)
        root = next(l for l in lines if l.startswith("main "))
        self.assertIn("CI ?", root)

    def test_scope_pr(self):
        rc, lines, _ = text(["--prs", "pr", "143", "--no-peers"])
        tree = [l for l in lines if l.startswith(("|--", "`--"))]
        self.assertEqual(len(tree), 1)
        self.assertIn("#143", tree[0])

    def test_hostile_title(self):
        raw = copy.deepcopy(RAW)
        raw["prs"][0]["title"] = "evil \x1b[2J\x1b]52;c;aGk=\x07title \u2014 caf\u00e9"
        rc, lines, _ = text(["--no-peers", "--no-claude"], fetch=FakeFetch(raw=raw))
        check_text_frame(self, lines)
        rc, md_lines, _ = run(["--no-peers", "--no-claude", "--format", "md"], fetch=FakeFetch(raw=raw))
        self.assertNotIn("\x1b", "\n".join(md_lines))


class Geometry(unittest.TestCase):
    """Skeleton -> final: once the PR list is known, loading states and spinner frames never move a
    line or a column."""

    def frames(self, views):
        argv, fetch = asked(["--format", "text"])
        if views:
            argv += views
        rc, final_lines, orch = run(argv, fetch=fetch)
        board, people = orch.snapshot(NOW)
        ctx_final = ghs.make_ctx(orch, orch.views, final=True, now=NOW)
        shape = ghs.shape_of(ctx_final, final_lines)
        return orch, ctx_final, shape

    def variants(self, ctx_final, shape):
        """Every combination of pending sources over the final data, spinner frames 0-3."""
        out = []
        board = ctx_final.board
        for jobs_pending, peers_pending, claude_pending in itertools.product([0, 1], repeat=3):
            for spin in range(4):
                ctx = copy.copy(ctx_final)
                ctx.final, ctx.spin, ctx.shape = False, spin, shape
                if claude_pending:
                    ctx.fill = None
                if peers_pending:
                    ps = copy.copy(ctx.peers)
                    ps.settled = False
                    ctx.peers = ps
                    p = dict(ctx.people)
                    p["settled"], p["pending"], p["silent"] = False, ["ee", "f1"], []
                    ctx.people = p
                if jobs_pending:
                    b = copy.copy(board)
                    rows = {}
                    for n, r in board["rows"].items():
                        r2 = dict(r)
                        if r2["run"] and r2["run"]["status"] in ghs.ACTIVE:
                            r2["ci"], r2["token"] = None, None
                        rows[n] = r2
                    b["rows"] = rows
                    m = dict(b["main"])
                    m["partial"] = True
                    b["main"] = m
                    ctx.board = b
                out.append(((jobs_pending, peers_pending, claude_pending, spin), ghs.render(ctx)))
        return out

    def assert_stable(self, frames, cols):
        base_key, base = frames[0]
        for key, lines in frames[1:]:
            self.assertEqual(len(lines), len(base), (key, "\n".join(lines)))
            for a, b in zip(base, lines):
                self.assertLessEqual(len(b), 90)
                if a.startswith(("|-- ", "`-- ", "main ")) and b.startswith(("|-- ", "`-- ", "main ")):
                    for c in cols:
                        if len(a) > c and len(b) > c:
                            self.assertEqual(a[c - 1], " ", (key, a))
                            self.assertEqual(b[c - 1], " ", (key, b))

    def test_default_view_stable(self):
        orch, ctx, shape = self.frames([])
        self.assert_stable(self.variants(ctx, shape), cols=(29, 39, 49, 56, 62))

    def test_prs_view_stable(self):
        orch, ctx, shape = self.frames(["--prs"])
        self.assert_stable(self.variants(ctx, shape), cols=(29, 39, 49, 56, 62))

    def test_skeleton_matches_final_shape(self):
        for views in ([], ["--prs"], ["--actions"], ["--one-line"]):
            with self.subTest(views=views):
                orch, ctx, shape = self.frames(views)
                final = ghs.render(ctx)
                sk = copy.copy(ctx)
                sk.board, sk.people, sk.fill, sk.final, sk.shape = None, None, None, False, shape
                sk_peers = copy.copy(ctx.peers)
                sk_peers.settled = False
                sk.peers = sk_peers
                skeleton = ghs.render(sk)
                check_text_frame(self, skeleton)
                # the skeleton reserves the same rows as the final tree/actions blocks
                self.assertEqual(len([l for l in skeleton if l.startswith(("|-- ", "`-- ", "|   `-- ", "    `-- "))]),
                                 len([l for l in final if l.startswith(("|-- ", "`-- ", "|   `-- ", "    `-- "))]))
                if "--actions" in views:
                    self.assertEqual(len(skeleton), len(final))
                for c in (29, 39, 49, 56, 62):
                    for l in skeleton:
                        if l.startswith(("|-- ", "`-- ")) and len(l) > c:
                            self.assertEqual(l[c - 1], " ", l)

    def test_no_cache_skeleton_defaults(self):
        orch, ctx, _ = self.frames([])
        sk = copy.copy(ctx)
        sk.board, sk.people, sk.fill, sk.final, sk.shape = None, None, None, False, {}
        lines = ghs.render(sk)
        self.assertEqual(len([l for l in lines if l.startswith(("|-- ", "`-- "))]), 6)
        self.assertEqual(len([l for l in lines if re.match(r"\d\. _+$", l)]), 3)
        self.assertTrue(lines[0].startswith("___  / reading GitHub ..."))


class Markdown(unittest.TestCase):
    def md(self, extra=(), **kw):
        argv, fetch = asked(list(extra) + ["--format", "md"], **kw)
        rc, lines, _ = run(argv, fetch=fetch)
        self.assertEqual(rc, 0)
        return lines

    def tables(self, lines):
        out, cur = [], []
        for l in lines + [""]:
            if l.startswith("|"):
                cur.append(l)
            elif cur:
                out.append(cur)
                cur = []
        return out

    @staticmethod
    def cols(row):
        return len(re.split(r"(?<!\\)\|", row)) - 2

    def test_default_md(self):
        lines = self.md()
        frame = "\n".join(lines)
        self.assertNotIn("```", frame)
        self.assertTrue(lines[0].startswith("**RED** · main is red"))
        self.assertTrue(lines[0].endswith(ghs.hhmm(NOW_DT)))
        tables = self.tables(lines)
        self.assertEqual(len(tables), 1)
        t = tables[0]
        self.assertEqual(t[0], "| # | PR | What | State | CI | ETA | Who | Note |")
        self.assertTrue(re.fullmatch(r"\|(?:---\|)+", t[1]))
        self.assertTrue(all(self.cols(r) == 8 for r in t), [self.cols(r) for r in t])
        self.assertTrue(t[2].startswith("|   | **main** `d5ce95a` |   | **RED** | `..3.56.8` | over |"))
        self.assertIn("| 1 | #93 | cloud DR docs | ready |", frame)
        self.assertIn("| 5 | #139 | CI test hygiene | **CONFLICT** |", frame)
        self.assertIn("|   | ↳ | #132 #133 #135 #140 #142 |", frame)
        self.assertIn("close after #143 merges |", frame)
        self.assertIn("**Needs you**", frame)
        self.assertIn("1. Fix main d5ce95a before the queue tests on it", frame)
        self.assertIn("drafts #81 superseded · #82 (36)->b2", frame)
        self.assertIn("other repo: auth #887", frame)

    def test_cell_lengths(self):
        lines = self.md()
        for row in self.tables(lines)[0][2:]:
            cells = [c.strip() for c in re.split(r"(?<!\\)\|", row)[1:-1]]
            self.assertLessEqual(len(cells[2].replace("\\", "")), 26, row)
            self.assertLessEqual(len(cells[7].replace("\\", "")), 40, row)

    def test_actions_md(self):
        lines = self.md(["--actions"])
        self.assertTrue(lines[0].startswith("**ACTIONS** · 1 running · 3 queued"))
        t = self.tables(lines)[0]
        self.assertEqual(t[0], "| Workflow | Branch / PR | Status | Elapsed |")
        self.assertTrue(all(self.cols(r) == 4 for r in t))
        self.assertNotIn("```", "\n".join(lines))

    def test_every_view_md_tables_rectangular(self):
        for v in RenderText.VIEWS:
            with self.subTest(views=v):
                lines = self.md(v)
                self.assertNotIn("```", "\n".join(lines))
                for t in self.tables(lines):
                    n = self.cols(t[0])
                    self.assertTrue(all(self.cols(r) == n for r in t), t)

    def test_one_line_md(self):
        lines = self.md(["--one-line"])
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r"^\*\*RED\*\* · .+ · \d\d:\d\dZ$")


def raw_with(*, extra_prs=(), extra_runs=(), extra_jobs=None):
    raw = copy.deepcopy(RAW)
    raw["prs"] += copy.deepcopy(list(extra_prs))
    raw["ci_runs"] = copy.deepcopy(list(extra_runs)) + raw["ci_runs"]
    raw["jobs"].update(copy.deepcopy(extra_jobs or {}))
    return raw


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


MAIN_FIX = {"number": 146, "title": "Fix main red shards 3 5 6 8", "headRefName": "fix/main-red-shards",
            "headRefOid": "f" * 40, "isDraft": False, "body": "", "mergeable": "MERGEABLE", "reviewDecision": "",
            "labels": [{"name": "ci:critical"}, {"name": "ci:order:1"}], "createdAt": iso(NOW - 3600),
            "updatedAt": iso(NOW - 600), "url": "u"}


def placeholder(conclusion):
    return {"databaseId": 1460, "status": "completed", "conclusion": conclusion, "headBranch": "fix/main-red-shards",
            "headSha": "f" * 40, "event": "pull_request", "createdAt": iso(NOW - 500), "startedAt": iso(NOW - 500),
            "updatedAt": iso(NOW - 499), "displayTitle": "PR #146 CI " + "f" * 40, "workflowName": "CI"}


class Regressions(unittest.TestCase):
    """One test per bug found in the first live runs."""

    def board(self, raw, argv=("--no-claude", "--no-peers", "--format", "text")):
        rc, lines, orch = run(list(argv), fetch=FakeFetch(raw=raw, claude_fn=good_claude))
        b, p = orch.snapshot(NOW)
        return b, p, lines

    def test_1_skipped_or_neutral_run_is_not_a_tested_run(self):
        for concl in ("skipped", "neutral"):
            with self.subTest(conclusion=concl):
                b, _, lines = self.board(raw_with(extra_prs=[MAIN_FIX], extra_runs=[placeholder(concl)]))
                r = b["rows"][146]
                self.assertIsNone(r["run"])
                self.assertEqual(b["queue"], [146, 144, 145, 143])     # still eligible, ci:order:1 first
                self.assertEqual((r["token"], r["ci"], r["why_not"]), ("q1", "-", None))
                self.assertEqual(r["eta_tok"], "~33m")
                row = next(l for l in lines if "#146" in l)
                self.assertNotIn("skip", row)
                self.assertNotIn("no CI", row)

    def test_2_tiers_bind_claude_order(self):
        head144 = next(p["headRefOid"] for p in RAW["prs"] if p["number"] == 144)
        running = {"databaseId": 1440, "status": "in_progress", "conclusion": "",
                   "headBranch": "fix/inbox-129-review-followup", "headSha": head144, "event": "workflow_dispatch",
                   "createdAt": iso(NOW - 300), "startedAt": iso(NOW - 300), "updatedAt": iso(NOW - 10),
                   "displayTitle": "PR #144 CI x", "workflowName": "CI"}
        jobs = {"1440": [{"name": f"E2E shard {k}", "status": "in_progress", "conclusion": ""} for k in range(1, 9)]}
        raw = raw_with(extra_prs=[MAIN_FIX], extra_runs=[placeholder("skipped"), running], extra_jobs=jobs)
        b, _, _ = self.board(raw)
        self.assertEqual(b["tree"], [146, 93, 144, 145, 143, 139, 80, 77])
        self.assertEqual([b["rows"][n]["tier"] for n in b["tree"]], [0, 1, 2, 3, 3, 6, 6, 6])
        # Claude puts conflicts first and the critical fix last: only the in-tier order survives
        bad = dict(GOOD, merge_order=[77, 80, 139, 143, 145, 144, 93, 146],
                   pr_notes=[{"pr": 144, "note": "CI running, not queued"}, {"pr": 93, "note": "merge after main"}])
        rc, lines, orch = run(["--no-peers", "--format", "md"], fetch=FakeFetch(raw=raw, claude_fn=lambda d: (bad, 0)))
        frame = "\n".join(lines)
        order = [int(m) for m in re.findall(r"^\| \d+ \| #(\d+) ", frame, re.M)]
        self.assertEqual(order, [146, 93, 144, 145, 143, 77, 80, 139])
        self.assertNotIn("not queued", frame)
        self.assertIn("merge after main", frame)

    def test_3_cuts_only_at_word_boundaries(self):
        title = "Scope the import duplicate check and keep restore controls visible on short screens"
        for w in range(8, len(title)):   # narrower than the first word = hard cut (by design)
            for ell in ("..", ghs.ELL):
                out = ghs.cut_words(title, w, ell)
                self.assertLessEqual(len(out), w)
                head = out[: -len(ell)]
                self.assertTrue(title.startswith(head))
                self.assertEqual(title[len(head)], " ", (w, out))   # cut right before a space

        def no_labels(d):
            return dict(GOOD, labels=[], pr_notes=[{"pr": 93, "note": "green on its head; merge after main"}]), 0
        rc, lines, _ = run(["--no-peers", "--format", "md"], fetch=FakeFetch(claude_fn=no_labels))
        table = "\n".join(l for l in lines if l.startswith("| "))
        self.assertNotIn("..", re.sub(r"`[^`]*`", "", table))   # ci strips are code spans
        self.assertIn("| #144 | Scope the import… |", table)
        self.assertIn(r"green on its head; merge after main \[2\]", table)   # a 36-char note arrives whole
        rc, tlines, _ = run(["--no-peers", "--format", "text"], fetch=FakeFetch(claude_fn=no_labels))
        self.assertTrue(all(ord(c) < 128 for l in tlines for c in l))
        self.assertIn("|-- #144  Scope the import..", "\n".join(tlines))

    def test_4_no_peers_still_reads_hints(self):
        fetch = FakeFetch(status_dir=peer_dir(), claude_fn=good_claude,
                          claims=[{"who": "widgets-ee", "prs": [139]}])
        t = time.monotonic()
        rc, lines, orch = run(["--no-peers", "--format", "text"], fetch=fetch)
        self.assertLess(time.monotonic() - t, 3)                     # nothing waited for
        b, p = orch.snapshot(NOW)
        self.assertEqual(p["mode"], "hints")
        self.assertEqual((p["who"][144], p["who"][145], p["who"][139]), ("c6", "f1", "ee"))
        self.assertIn("claims", fetch.calls)
        self.assertIn("|-- #144  #129 follow-up     q1        -         ~33m   c6", "\n".join(lines))
        self.assertFalse((fetch.sd / "_request.json").exists())       # nobody was asked

    def test_5_claude_starts_before_slow_job_fetches(self):
        stamps = {}

        def timed(d):
            stamps["claude"] = time.monotonic()
            return good_claude(d)
        slow = FakeFetch(claude_fn=timed, delays={"jobs:38170413400": 1.5})
        t = time.monotonic()
        run(["--no-peers", "--format", "text"], fetch=slow)
        self.assertLess(stamps["claude"] - t, 1.0)
        fast = FakeFetch(claude_fn=good_claude)
        run(["--no-peers", "--format", "text"], fetch=fast)
        # the digest does not depend on which job fetches had landed, so the cache key is stable
        self.assertEqual(ghs.material_key(slow.digests[0], "m"), ghs.material_key(fast.digests[0], "m"))
        # a finished main is judged by its conclusion: Claude does not wait for main's jobs either
        raw = copy.deepcopy(RAW)
        for r in raw["ci_runs"]:
            if r["databaseId"] == 38867130136:
                r.update(status="completed", conclusion="failure", updatedAt=iso(NOW - 60))
        stamps.clear()
        done_main = FakeFetch(raw=raw, claude_fn=timed, delays={"jobs:38867130136": 1.5})
        t = time.monotonic()
        rc, lines, _ = run(["--no-peers", "--format", "text"], fetch=done_main)
        self.assertLess(stamps["claude"] - t, 1.0)
        self.assertTrue(lines[0].startswith("RED  "))
        self.assertEqual(done_main.digests[0]["main"]["verdict"], "failure")


def failed_run(rid, n, shards_failed, extra_failed=(), total_shards=8):
    pr = next(p for p in RAW["prs"] if p["number"] == n)
    run = {"databaseId": rid, "status": "completed", "conclusion": "failure", "headBranch": pr["headRefName"],
           "headSha": pr["headRefOid"], "event": "workflow_dispatch", "createdAt": iso(NOW - 3000),
           "startedAt": iso(NOW - 3000), "updatedAt": iso(NOW - 900), "displayTitle": f"PR #{n} CI x",
           "workflowName": "CI"}
    jobs = [{"name": f"E2E shard {k}", "status": "completed",
             "conclusion": "failure" if k in shards_failed else "success"} for k in range(1, total_shards + 1)]
    jobs += [{"name": name, "status": "completed", "conclusion": "failure"} for name in extra_failed]
    jobs.append({"name": "Required CI gate", "status": "completed", "conclusion": "failure"})
    return run, {str(rid): jobs}


class Regressions2(unittest.TestCase):
    """Second round of live-run bugs: FAIL tokens, stale hints, Who names."""

    def test_6_fail_tokens_spell_out_shards(self):
        self.assertEqual(ghs.fit_state("FAIL 3,5,6,8", 9), "FAIL x4")
        self.assertEqual(ghs.fit_state("FAIL 3,5,6,8", 16, "×"), "FAIL 3,5,6,8")
        self.assertEqual(ghs.fit_state("FAIL 3,5", 9), "FAIL 3,5")
        self.assertEqual(ghs.fit_state("FAIL x2", 16, "×"), "FAIL ×2")
        self.assertEqual(ghs.fit_state("FAIL sh 3", 9), "FAIL sh 3")
        r144, j144 = failed_run(1441, 144, {3, 5})            # subset of main's 3,5,6,8
        r145, j145 = failed_run(1451, 145, {4})               # its own failure
        r143, j143 = failed_run(1431, 143, {3, 6}, extra_failed=["Unit tests"])   # main's shards + its own job
        raw = raw_with(extra_runs=[r144, r145, r143], extra_jobs={**j144, **j145, **j143})
        rc, lines, orch = run(["--no-peers", "--no-claude", "--format", "text"], fetch=FakeFetch(raw=raw))
        b, _ = orch.snapshot(NOW)
        rows = b["rows"]
        self.assertEqual([rows[n]["token"] for n in (144, 145, 143)], ["FAIL 3,5", "FAIL sh 4", "FAIL 3,6"])
        self.assertEqual([rows[n]["inherits"] for n in (144, 145, 143)], [True, False, False])
        self.assertEqual([rows[n]["tier"] for n in (144, 145, 143)], [5, 5, 5])
        frame = "\n".join(lines)
        self.assertIn("FAIL 3,5", frame)
        self.assertIn("inherits main's red", next(l for l in lines if "#144" in l))
        self.assertIsNone(re.search(r"FAIL \d(?![,\d])", frame), frame)       # never a bare digit
        rc, md_lines, _ = run(["--no-peers", "--format", "md"], fetch=FakeFetch(raw=raw, claude_fn=good_claude))
        row144 = next(l for l in md_lines if "| #144 |" in l)
        row145 = next(l for l in md_lines if "| #145 |" in l)
        self.assertIn("| FAIL 3,5 |", row144)                  # main's red: not bold, not the PR's failure
        self.assertIn("inherits main's red", row144)
        self.assertIn("| **FAIL sh 4** |", row145)
        main_row = next(l for l in md_lines if "**main**" in l)
        self.assertIn("**RED**", main_row)
        rc, act, _ = run(["--actions", "--format", "md"], fetch=FakeFetch(claude_fn=good_claude))
        self.assertIn("**FAIL 3,5,6,8**", "\n".join(act))

    def test_7_stale_hints_never_contradict(self):
        # 12's file is 20 minutes old: a hint, not this round's reply (files over 30 min are ignored)
        sd = peer_dir(offsets={"widgets-12": 1200})
        stale_claude = dict(GOOD, needs_you=GOOD["needs_you"] + [
            {"verb": "answer", "prs": [143], "main": False, "text": "Answer 12: it says CI is running on #143, correct it"}])
        fetch = FakeFetch(status_dir=sd, claude_fn=lambda d: (copy.deepcopy(stale_claude), 0))
        rc, lines, orch = run(["--no-peers", "--format", "md"], fetch=fetch)
        frame = "\n".join(lines)
        b, p = orch.snapshot(NOW)
        self.assertEqual(p["contra"], {})
        self.assertNotIn("! 12", frame)
        self.assertNotIn("correct it", frame)
        self.assertEqual(p["who_md"][143], "12 20m")
        self.assertIn("| 12 20m |", next(l for l in lines if "| #143 |" in l))
        self.assertTrue(fetch.digests[0]["peers"][0]["stale"] or any(x["stale"] for x in fetch.digests[0]["peers"]))
        # the same file written 3 minutes ago is current: the contradiction stands
        sd2 = peer_dir(offsets={"widgets-12": 180})
        rc, lines2, orch2 = run(["--no-peers", "--format", "text"], fetch=FakeFetch(status_dir=sd2, claude_fn=good_claude))
        self.assertEqual(orch2.snapshot(NOW)[1]["contra"], {143: "! 12 says CI running"})
        # asked mode: an old file from before this round is stale too
        argv, fetch3 = asked(["--format", "text"], offsets={"widgets-12": 1200})
        rc, lines3, orch3 = run(argv, fetch=fetch3)
        p3 = orch3.snapshot(NOW)[1]
        self.assertEqual(p3["contra"], {})
        self.assertIn("12", p3["silent"])

    def test_8_who_names(self):
        self.assertEqual(ghs.display_name("combined-ci-test-hygiene", "…"), "combined…")
        self.assertEqual(ghs.display_name("fleet status reply"), "fleet")
        self.assertEqual(ghs.display_name("b2"), "b2")
        self.assertEqual(ghs.text_who("combined-ci-test-hygiene"), "com..")
        ee = FIX / "peers_extra" / "combined-ci-test-hygiene.txt"
        # without an owner for #139, the branch-named peer keeps its own (cut) name
        sd = peer_dir(names=["widgets-c6"])
        shutil.copy(ee, sd / ee.name)
        os.utime(sd / ee.name, (NOW - 30, NOW - 30))
        rc, lines, orch = run(["--no-peers", "--format", "md"], fetch=FakeFetch(status_dir=sd, claude_fn=good_claude))
        p = orch.snapshot(NOW)[1]
        self.assertEqual(p["who_md"][139], "combined…")
        self.assertEqual(p["who"][139], "com..")
        self.assertIn("| combined… |", next(l for l in lines if "| #139 |" in l))
        # b2 names ee as #139's owner ("#139 (ee, ...)"): the branch-named file is ee's reply
        sd2 = peer_dir()
        shutil.copy(ee, sd2 / ee.name)
        os.utime(sd2 / ee.name, (NOW - 30, NOW - 30))
        argv = ["--peers-since", str(NOW - 70), "--peers", ",".join(PEERS), "--self", "widgets-c7", "--format", "md"]
        rc, lines2, orch2 = run(argv, fetch=FakeFetch(status_dir=sd2, claude_fn=good_claude))
        p2 = orch2.snapshot(NOW)[1]
        self.assertEqual(p2["alias"], {"combined-ci-test-hygiene": "ee"})
        self.assertEqual((p2["who"][139], p2["who_md"][139]), ("ee", "ee"))
        self.assertEqual(p2["silent"], [])                     # ee did reply, under its branch name
        self.assertEqual(len(p2["replied"]), 8)
        self.assertIn("| ee |", next(l for l in lines2 if "| #139 |" in l))


class JsonOutput(unittest.TestCase):
    def test_v2_keys_kept(self):
        argv, fetch = asked(["--json"])
        rc, lines, _ = run(argv, fetch=fetch)
        self.assertEqual(len(lines), 1)
        d = json.loads(lines[0])
        for k in ("repo", "generated_utc", "typical_ci", "main", "queue_reservation", "queue_predicted", "prs",
                  "closed_members", "active_runs", "codex", "peers", "claims", "claude", "sources"):
            self.assertIn(k, d)
        self.assertEqual(d["queue_predicted"], [144, 145, 143])
        self.assertEqual(d["queue_reservation"], "clear")
        p93 = next(p for p in d["prs"] if p["number"] == 93)
        self.assertEqual((p93["state"], p93["eta"], p93["view"]["token"]), ("ready", "now", "ready"))
        self.assertEqual(d["claude"]["status"], "claude")


class Terminal(unittest.TestCase):
    class Size:
        def __init__(self, c, l):
            self.columns, self.lines = c, l

        def __eq__(self, o):
            return (self.columns, self.lines) == (o.columns, o.lines)

    def term(self, cols=100, rows=40):
        out = io.StringIO()
        return out, ghs.LiveTerminal(out, alt=False, color=False, size_fn=lambda: self.Size(cols, rows))

    def test_relative_redraw(self):
        out, t = self.term()
        t.draw(["a", "b", "c"])
        first = out.getvalue()
        self.assertNotIn("\x1b[3F", first)
        self.assertIn("\x1b[?25l", first)
        self.assertIn("\x1b[?2026h", first)
        t.draw(["a", "B", "c"])
        second = out.getvalue()[len(first):]
        self.assertTrue(second.startswith("\x1b[?2026h\x1b[3F"))
        self.assertEqual(second.count("\x1b[K\n"), 3)
        self.assertNotIn("\x1b[2J", out.getvalue())
        n = len(out.getvalue())
        t.draw(["a", "B", "c"])                      # identical frame: nothing written
        self.assertEqual(len(out.getvalue()), n)
        t.close()
        self.assertTrue(out.getvalue().endswith("\x1b[?25h"))

    def test_clipping(self):
        out, t = self.term(cols=20, rows=4)
        t.draw(["x" * 50] * 10)
        body = out.getvalue()
        self.assertEqual(body.count("\x1b[K\n"), 3)
        self.assertNotIn("x" * 20, body)
        t.finish(["y" * 50] * 10)                   # the final frame is not clipped
        self.assertIn("y" * 50, out.getvalue())

    def test_live_run_draws_skeleton_then_final(self):
        out, t = self.term()
        fetch = FakeFetch(claude_fn=good_claude, delays={"prs": 0.3})
        args, views = ghs.parse_args(["--no-peers"])
        rc, lines, _ = ghs.run_once(args, views, ghs.Caches(disk=False), fetch, t, now_fn=Clock())
        t.finish(lines)
        t.close()
        body = out.getvalue()
        self.assertIn("reading GitHub", body)       # skeleton was drawn before data arrived
        self.assertNotIn("\x1b[2J", body)
        self.assertEqual(lines[1], "")
        self.assertTrue(lines[0].startswith("RED  "))  # text format in a terminal

    def test_vt_failure_means_final_only(self):
        args, _ = ghs.parse_args([])
        orig = ghs.enable_vt_mode
        ghs.enable_vt_mode = lambda: False
        try:
            class TTY(io.StringIO):
                def isatty(self):
                    return True
            self.assertFalse(ghs.stdout_is_live(args, TTY()))
        finally:
            ghs.enable_vt_mode = orig
        self.assertFalse(ghs.stdout_is_live(args, io.StringIO()))   # a pipe is never live


class NonTTY(unittest.TestCase):
    def test_exactly_one_frame_nothing_on_stderr(self):
        out, err = io.StringIO(), io.StringIO()
        argv, fetch = asked()
        old_err = sys.stderr
        sys.stderr = err
        try:
            rc = ghs.main(argv, fetch=fetch, out=out)
        finally:
            sys.stderr = old_err
        body = out.getvalue()
        self.assertEqual(rc, 0)
        self.assertEqual(err.getvalue(), "")
        self.assertNotIn("\x1b", body)
        self.assertTrue(body.startswith("**RED** · "))      # md by default in a pipe
        self.assertEqual(body.count("| # | PR |"), 1)
        self.assertNotIn("```", body)
        self.assertNotIn("____", body)
        self.assertNotIn("reading GitHub", body)

    def test_peer_wait_ends_at_deadline(self):
        # ee never replies: the run waits until peers-since + timeout, then reports it silent.
        sd = peer_dir()
        fetch = FakeFetch(status_dir=sd, claude_fn=good_claude)
        argv = ["--peers-since", str(NOW - 58), "--peers", ",".join(PEERS), "--self", "x", "--peer-timeout", "60",
                "--format", "text"]
        t = time.monotonic()
        rc, lines, orch = run(argv, fetch=fetch)
        self.assertGreaterEqual(time.monotonic() - t, 1.5)
        self.assertLess(time.monotonic() - t, 8)
        self.assertIn("silent ee", "\n".join(lines))

    def test_late_reply_counts(self):
        sd = peer_dir(names=[p for p in PEERS if p != "widgets-f1"])
        fetch = FakeFetch(status_dir=sd, claude_fn=good_claude)
        argv = ["--peers-since", str(NOW - 57), "--peers", ",".join(p for p in PEERS if p != "widgets-ee"),
                "--self", "x", "--format", "text"]

        def late():
            time.sleep(1.0)
            src = FIX / "peers" / "widgets-f1.txt"
            shutil.copy(src, sd / src.name)
        threading.Thread(target=late).start()
        rc, lines, orch = run(argv, fetch=fetch)
        self.assertIn("7/7 replied", "\n".join(lines))


class FreshLines(unittest.TestCase):
    """Sessions keep their status line current; the dashboard reuses recent lines instead of asking."""

    ASKED = ",".join(p for p in PEERS if p != "widgets-ee")

    def test_recent_lines_count_as_replies_with_fresh_within(self):
        # Every line was written before the ask (since = NOW - 5), the oldest 10 minutes before.
        sd = peer_dir(offsets={"widgets-f1": 600})
        argv = ["--peers-since", str(NOW - 5), "--fresh-within", "900", "--peers", self.ASKED, "--self", "x",
                "--peer-timeout", "60", "--format", "text"]
        t = time.monotonic()
        rc, lines, orch = run(argv, fetch=FakeFetch(status_dir=sd, claude_fn=good_claude))
        self.assertLess(time.monotonic() - t, 8)
        self.assertIn("7/7 replied", "\n".join(lines))
        # The ask time itself is unchanged; only the freshness window reaches back.
        self.assertEqual(orch.peers.since, NOW - 5)
        self.assertEqual(orch.peers.fresh_since, NOW - 905)

    def test_lines_older_than_the_ask_do_not_count_without_it(self):
        sd = peer_dir()
        argv = ["--peers-since", str(NOW - 5), "--peers", self.ASKED, "--self", "x", "--peer-timeout", "7",
                "--format", "text"]
        rc, lines, orch = run(argv, fetch=FakeFetch(status_dir=sd, claude_fn=good_claude))
        self.assertNotIn("7/7 replied", "\n".join(lines))

    def test_status_dir_recent_lists_current_writers(self):
        sd = Path(tempfile.mkdtemp(prefix="ghs-recent-"))
        now = time.time()
        for name, age in (("fresh-a", 60), ("fresh-b", 600), ("old-c", 3600)):
            (sd / f"{name}.txt").write_text(f"{name} | #1 | x | - | none | - | -\n", encoding="utf-8")
            os.utime(sd / f"{name}.txt", (now - age, now - age))
        (sd / "empty-d.txt").write_text("", encoding="utf-8")
        saved, ghs.STATUS_DIR = ghs.STATUS_DIR, sd
        try:
            out = io.StringIO()
            self.assertEqual(ghs.main(["status-dir", "--recent", "15"], out=out), 0)
        finally:
            ghs.STATUS_DIR = saved
        first, epoch, recent = out.getvalue().splitlines()
        self.assertEqual(first, str(sd))
        self.assertLessEqual(abs(int(epoch) - now), 5)
        self.assertEqual(recent, "fresh-a,fresh-b")


if __name__ == "__main__":
    unittest.main(verbosity=1)
