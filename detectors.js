"use strict";

// detectors.js - loop and repeat-failure detectors. Pure functions: no I/O, no clock, no state.
//
// Why this exists: the alarm that used to show "loop thrashing" fired when a session had three failed tool calls
// anywhere in the last 24 hours. Over a week of real transcripts that flagged 75.6% of active samples while a strict
// repeat-loop check matched 0.6% of the flags. Failing a tool call is normal; repeating the same call is not.
//
// The rules are exact matches over a small window, the same family the shipping agents use (OpenHands: same action
// and observation 4 times, same failing action 3 times; Roo, Cline, OpenCode: 3 identical calls). They only
// ever label. Nothing here kills, restarts or types into a session.
//
// An event is one finished tool call:
//   { name, hash, ok, err, out, poll }
//     name  tool name
//     hash  hash of the call's input (the same input means the same hash)
//     ok    false when the result was flagged as an error
//     err   hash of the error text when ok is false, else ""
//     out   hash of the start of the result text
//     poll  true for calls that are legitimately repeated while waiting (sleep, git status, ...)
// Events are the calls made since the last human prompt, oldest first.

const crypto = require("crypto");

const hashOf = (s) => crypto.createHash("md5").update(String(s)).digest("hex").slice(0, 12);

// Shell commands that are meant to be repeated while waiting for something. They never count as a loop on
// their own (a repeated failure still does).
const POLL = /\b(sleep|Start-Sleep|git\s+status|git\s+log|git\s+fetch|Get-Date|Get-Process|tasklist|Wait-Process)\b/i;
function isPoll(name, input) {
  if (name !== "Bash" && name !== "PowerShell") return false;
  return POLL.test(String((input && input.command) || ""));
}

const WINDOW = 40;
const SEVERITY = { alarm: 2, watch: 1 };

// length of the run of equal keys at the end of the list
function tailRun(events, keyOf) {
  let n = 0, key = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const k = keyOf(events[i]);
    if (key === null) key = k;
    if (k !== key) break;
    n++;
  }
  return n;
}

// Returns null, or the most serious finding: { id, severity: "alarm" | "watch", label, count }.
function detect(events) {
  if (!Array.isArray(events) || events.length < 3) return null;
  const tail = events.slice(-WINDOW);
  const last = tail[tail.length - 1];
  const act = (e) => e.name + ":" + e.hash;
  const found = [];

  if (!last.poll) {
    const same = tailRun(tail, act);
    const sameOut = tailRun(tail, (e) => act(e) + ":" + (e.ok ? "ok" : "err") + ":" + (e.ok ? e.out : e.err));
    if (sameOut >= 4 || same >= 5) found.push({ id: "hard_loop", severity: "alarm", label: `Repeating the same ${last.name} call`, count: Math.max(same, sameOut) });
    else if (same >= 3) found.push({ id: "possible_loop", severity: "watch", label: `Same ${last.name} call ${same} times in a row`, count: same });
  }

  if (!last.ok) {
    const failing = tailRun(tail, (e) => (e.ok ? "ok" : act(e) + ":" + e.err));
    if (failing >= 3) found.push({ id: "repeat_error", severity: "alarm", label: `Same ${last.name} failure ${failing} times in a row`, count: failing });
  }

  // A, B, A, B, A, B, A, B with A different from B
  if (tail.length >= 8 && !last.poll) {
    const ks = tail.slice(-8).map(act);
    let alternates = ks[0] !== ks[1];
    for (let i = 2; i < 8 && alternates; i++) if (ks[i] !== ks[i - 2]) alternates = false;
    if (alternates) found.push({ id: "alternating", severity: "watch", label: `Switching between two calls (${tail[tail.length - 2].name}, ${last.name})`, count: 4 });
  }

  if (!found.length) return null;
  found.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || b.count - a.count);
  return found[0];
}

module.exports = { detect, hashOf, isPoll, WINDOW };
