--------------------------- MODULE BoardSaveQueue ---------------------------
(* A model of src/board/saveQueue.ts as BoardApp uses it for the board's
   autosave (FR-704): push, retry, clear, flush, and the run() loop.

   JavaScript runs one piece of code at a time and switches only at an await.
   Each action below is one such piece. Anything the page does (an edit, the
   retry button, closing the window) can come between any two of them.

   Snapshot k is the k-th push. The server keeps the last snapshot it saved.
   Mutation selects a deliberately broken variant (see SKILL.md). *)
EXTENDS Naturals, FiniteSets

CONSTANTS MaxPush, MaxFails, Mutation

Slots == {1, 2}   \* run() calls; the code allows one, a mutant may start two

VARIABLES
    latest,   \* the last snapshot pushed (0 = the board as opened)
    saved,    \* the last snapshot the server saved
    dropped,  \* snapshots up to this one were thrown away by clear()
    pending,  \* the snapshot in `pending`, 0 = null
    running,  \* the run() that `running` holds, 0 = null
    rpc,      \* [Slots -> {"idle", "sending", "returned"}]: "returned" only in lateRunningReset
    rsnap,    \* [Slots -> snapshot] what each run() is sending
    shown,    \* the last onState: "saved", "saving", "failed"
    fpc,      \* flush(): "none", "waiting", "wake", "resolved", "rejected"
    fwait,    \* the run() that flush() awaits
    fok,      \* when flush() resolved, the last snapshot was saved
    fails

vars == <<latest, saved, dropped, pending, running, rpc, rsnap, shown, fpc, fwait, fok, fails>>

Init ==
    /\ latest = 0 /\ saved = 0 /\ dropped = 0 /\ pending = 0 /\ running = 0
    /\ rpc = [s \in Slots |-> "idle"] /\ rsnap = [s \in Slots |-> 0]
    /\ shown = "saved" /\ fpc = "none" /\ fwait = 0 /\ fok = TRUE /\ fails = 0

UpToDate == saved = latest \/ latest <= dropped
Free == {s \in Slots : rpc[s] = "idle"}

\* kick(): with running set, nothing. With nothing pending, show saved.
\* Else running = run(), which goes on by itself up to its first await:
\* it takes pending and calls send(). p is pending as the caller left it.
Kick(p) ==
    CASE (running # 0 /\ Mutation # "noRunningGuard") \/ Free = {} ->
           pending' = p /\ UNCHANGED <<running, rpc, rsnap, shown>>
      [] p = 0 ->
           pending' = 0 /\ shown' = "saved" /\ UNCHANGED <<running, rpc, rsnap>>
      [] OTHER ->
           LET s == CHOOSE x \in Free : TRUE IN
           /\ running' = s
           /\ pending' = 0
           /\ rsnap' = [rsnap EXCEPT ![s] = p] /\ rpc' = [rpc EXCEPT ![s] = "sending"] /\ shown' = "saving"

\* run() ends: running = null in the same piece of code, and a flush() that
\* awaits this run() may go on. lateRunningReset is the old code: running is
\* cleared later, by .finally() (Finally).
End(s) ==
    IF Mutation = "lateRunningReset"
      THEN rpc' = [rpc EXCEPT ![s] = "returned"] /\ UNCHANGED <<running, fpc>>
      ELSE /\ rpc' = [rpc EXCEPT ![s] = "idle"]
           /\ running' = 0
           /\ fpc' = IF fpc = "waiting" /\ fwait = s THEN "wake" ELSE fpc

---------------------------------------------------------------------------
\* push(snapshot): an edit on the board (commit() in BoardApp)
Push ==
    /\ latest < MaxPush
    /\ latest' = latest + 1
    /\ Kick(latest + 1)
    /\ UNCHANGED <<saved, dropped, fpc, fwait, fok, fails>>

\* retry(): the 再試行 button, shown only while the state is failed
Retry ==
    /\ shown = "failed"
    /\ Kick(pending)
    /\ UNCHANGED <<latest, saved, dropped, fpc, fwait, fok, fails>>

\* clear(): the board was deleted; its edits have nowhere to go
Clear ==
    /\ dropped < latest
    /\ dropped' = latest
    /\ pending' = 0
    /\ shown' = IF running = 0 THEN "saved" ELSE shown
    /\ UNCHANGED <<latest, saved, running, rpc, rsnap, fpc, fwait, fok, fails>>

\* await send(snapshot) succeeds; the loop takes the next pending or ends
SendOk(s) ==
    /\ rpc[s] = "sending"
    /\ saved' = rsnap[s]
    /\ IF pending # 0
         THEN rsnap' = [rsnap EXCEPT ![s] = pending] /\ pending' = 0 /\ shown' = "saving" /\ UNCHANGED rpc
              /\ UNCHANGED <<running, fpc>>
         ELSE End(s) /\ shown' = "saved" /\ UNCHANGED <<rsnap, pending>>
    /\ UNCHANGED <<latest, dropped, fwait, fok, fails>>

\* await send(snapshot) throws: keep a newer edit if one came, else this one
SendFail(s) ==
    /\ rpc[s] = "sending"
    /\ fails < MaxFails
    /\ fails' = fails + 1
    /\ pending' = CASE Mutation = "dropOnFail" -> pending
                    [] Mutation = "failOverwrites" -> rsnap[s]
                    [] OTHER -> IF pending = 0 THEN rsnap[s] ELSE pending
    /\ shown' = IF Mutation = "savedOnFail" THEN "saved" ELSE "failed"
    /\ End(s)
    /\ UNCHANGED <<latest, saved, dropped, rsnap, fwait, fok>>

\* lateRunningReset only: .finally(() => (running = null)), after run() ended
Finally(s) ==
    /\ rpc[s] = "returned"
    /\ rpc' = [rpc EXCEPT ![s] = "idle"]
    /\ running' = 0
    /\ fpc' = IF fpc = "waiting" /\ fwait = s THEN "wake" ELSE fpc
    /\ UNCHANGED <<latest, saved, dropped, pending, rsnap, shown, fwait, fok, fails>>

\* flush(): closing the window, switching or creating a board
FlushStart ==
    /\ fpc \in {"none", "resolved", "rejected"}
    /\ IF running # 0
         THEN fpc' = "waiting" /\ fwait' = running
              /\ UNCHANGED <<pending, running, rpc, rsnap, shown, fok>>
         ELSE IF pending # 0
           THEN Kick(pending) /\ fpc' = "waiting" /\ fwait' = running' /\ UNCHANGED fok
           ELSE fpc' = "resolved" /\ fok' = UpToDate
                /\ UNCHANGED <<pending, running, rpc, rsnap, shown, fwait>>
    /\ UNCHANGED <<latest, saved, dropped, fails>>

\* flush() goes on after the run() it awaited: if (pending && !running) throw error,
\* then while (running || pending) waits again. flushNoLoop waits only once.
FlushResume ==
    /\ fpc = "wake"
    /\ CASE pending # 0 /\ running = 0 -> fpc' = "rejected" /\ UNCHANGED <<fok, fwait>>
         [] running # 0 /\ Mutation # "flushNoLoop" -> fpc' = "waiting" /\ fwait' = running /\ UNCHANGED fok
         [] OTHER -> fpc' = "resolved" /\ fok' = UpToDate /\ UNCHANGED fwait
    /\ UNCHANGED <<latest, saved, dropped, pending, running, rpc, rsnap, shown, fails>>

Next ==
    \/ Push \/ Retry \/ Clear \/ FlushStart \/ FlushResume
    \/ \E s \in Slots : SendOk(s) \/ SendFail(s) \/ Finally(s)

\* The page's own code runs on; the user presses 再試行 when it is shown.
\* Edits, deleting the board and closing the window are up to the user.
Spec == Init /\ [][Next]_vars
        /\ \A s \in Slots : WF_vars(SendOk(s) \/ SendFail(s)) /\ WF_vars(Finally(s))
        /\ WF_vars(FlushResume) /\ WF_vars(Retry)

---------------------------------------------------------------------------
\* Two saves at once: the second is sent with the same revision and refused.
OneInFlight == Cardinality({s \in Slots : rpc[s] = "sending"}) <= 1

\* The last edit is saved, waiting, or being sent, unless the board was deleted.
NoLostEdit ==
    \/ UpToDate
    \/ pending = latest
    \/ \E s \in Slots : rpc[s] = "sending" /\ rsnap[s] = latest

\* 保存済み is shown only when the last edit is saved (FR-704).
SavedMeansSaved == shown = "saved" => UpToDate

\* When flush() resolves, the last edit was saved: closing or switching is safe.
FlushMeansSaved == fpc = "resolved" => fok

\* Once edits and failures stop, the last edit is saved and 保存済み is shown.
EventuallySaved == <>[](shown = "saved" /\ UpToDate)
=============================================================================
