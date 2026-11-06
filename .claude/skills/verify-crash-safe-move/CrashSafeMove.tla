---------------------------- MODULE CrashSafeMove ----------------------------
(* A model of one file operation in src-tauri/src/fileops.rs: transfer() and
   the cleanup it shares with startup, settle() / recover().
   The process may crash between any two durable steps; after a crash,
   library::connect() runs recover() before anything else.

   Durable state: the three paths the operation touches, the pending_ops row,
   and where the images row says the image is. pc and ctx are lost on crash.

   Mutation selects a deliberately broken variant (see SKILL.md). "none" is
   the code as it is. *)
EXTENDS Naturals, FiniteSets

CONSTANTS MaxCrashes, MaxApplyFails, MaxOpFails, Mutation

\* Request.copy = false and the names differ        -> "move"     (rename_excl(src, dst))
\* Request.copy = false and only the case differs   -> "caseOnly" (src -> tmp -> dst)
\* Request.copy = true (import)                     -> "copy"     (fs::copy to tmp, tmp -> dst)
Modes == {"move", "caseOnly", "copy"}
\* src = op.src, tmp = tmp_path(op) (".kura-tmp-<id>" next to dst), dst = op.dst
Locs == {"src", "tmp", "dst"}
Contents == {"none", "partial", "full"}

VARIABLES
    mode,        \* which branch of transfer() this operation takes
    file,        \* [Locs -> Contents]: what is on disk at each path
    pending,     \* the pending_ops row for this operation exists
    db,          \* where the images row puts the image: "src", "dst", or "none" (no row yet: import)
    pc,          \* where the process is (volatile)
    ctx,         \* "transfer" (in-process error path) or "recovery" (recover() at startup)
    crashes, applyFails, opFails

vars == <<mode, file, pending, db, pc, ctx, crashes, applyFails, opFails>>
counters == <<crashes, applyFails, opFails>>

Rename(from, to) == file' = [file EXCEPT ![from] = "none", ![to] = file[from]]

\* The DB change that finish() commits. apply_move etc. point the row at op.dst.
\* For "import", transfer's own closure inserts the row, but library::apply_op
\* (used by recover) does nothing: FR-104 registers the file later.
ApplyDb == IF mode = "copy" /\ ctx = "recovery" THEN db ELSE "dst"

Init ==
    /\ mode \in Modes
    /\ file = [l \in Locs |-> IF l = "src" THEN "full" ELSE "none"]
    /\ pending = FALSE
    /\ db = IF mode = "copy" THEN "none" ELSE "src"
    /\ pc = "start"
    /\ ctx = "transfer"
    /\ crashes = 0 /\ applyFails = 0 /\ opFails = 0

---------------------------------------------------------------------------
\* transfer(): record() -- INSERT INTO pending_ops, committed on its own
Record ==
    /\ pc = "start"
    /\ IF Mutation = "renameBeforeRecord" /\ mode = "move"
         THEN Rename("src", "dst") /\ pc' = "renamedUnrecorded" /\ UNCHANGED pending
         ELSE pending' = TRUE /\ pc' = "recorded" /\ UNCHANGED file
    /\ UNCHANGED <<mode, db, ctx, counters>>

RecordLate ==   \* only reachable in the renameBeforeRecord mutation
    /\ pc = "renamedUnrecorded"
    /\ pending' = TRUE /\ pc' = "renamed"
    /\ UNCHANGED <<mode, file, db, ctx, counters>>

\* transfer(), plain move: rename_excl(&src_abs, &dst_abs)
RenameSrcDst ==
    /\ pc = "recorded" /\ mode = "move"
    /\ Rename("src", "dst") /\ pc' = "renamed"
    /\ UNCHANGED <<mode, pending, db, ctx, counters>>

\* transfer(), case_only: rename_excl(&src_abs, &tmp)
RenameSrcTmp ==
    /\ pc = "recorded" /\ mode = "caseOnly"
    /\ Rename("src", "tmp") /\ pc' = "tmpReady"
    /\ UNCHANGED <<mode, pending, db, ctx, counters>>

\* transfer(), copy: fs::copy(&src_abs, &tmp) is not atomic; a crash can leave part of a file
CopyBegin ==
    /\ pc = "recorded" /\ mode = "copy"
    /\ LET to == IF Mutation = "copyIntoDst" THEN "dst" ELSE "tmp"
       IN file' = [file EXCEPT ![to] = "partial"]
    /\ pc' = "copying"
    /\ UNCHANGED <<mode, pending, db, ctx, counters>>

CopyEnd ==
    /\ pc = "copying"
    /\ IF Mutation = "copyIntoDst"
         THEN file' = [file EXCEPT !["dst"] = "full"] /\ pc' = "renamed"
         ELSE file' = [file EXCEPT !["tmp"] = "full"] /\ pc' = "tmpReady"
    /\ UNCHANGED <<mode, pending, db, ctx, counters>>

\* transfer(): rename_excl(&tmp, &dst_abs)
RenameTmpDst ==
    /\ pc = "tmpReady"
    /\ Rename("tmp", "dst") /\ pc' = "renamed"
    /\ UNCHANGED <<mode, pending, db, ctx, counters>>

\* A rename or the copy returns Err with no further effect (permissions, disk full, ...).
\* transfer() then calls settle(lib, &op, apply).
OpFails ==
    /\ pc \in {"recorded", "copying", "tmpReady"}
    /\ opFails < MaxOpFails
    /\ opFails' = opFails + 1
    /\ pc' = "settle" /\ ctx' = "transfer"
    /\ UNCHANGED <<mode, file, pending, db, crashes, applyFails>>

\* finish(): apply and drop_op in one transaction. Commits both or neither.
FinishCommit ==
    IF Mutation = "dropBeforeApply"
      THEN pending' = FALSE /\ pc' = "applyAfterDrop" /\ UNCHANGED db
      ELSE db' = ApplyDb /\ pending' = FALSE /\ pc' = "done"

ApplyAfterDrop ==   \* only reachable in the dropBeforeApply mutation
    /\ pc = "applyAfterDrop"
    /\ db' = ApplyDb /\ pc' = "done"
    /\ UNCHANGED <<mode, file, pending, ctx, counters>>

\* transfer(): result.and_then(|_| finish(lib, &op, apply)); on Err -> settle()
Finish ==
    /\ pc = "renamed"
    /\ \/ FinishCommit /\ UNCHANGED applyFails /\ UNCHANGED ctx
       \/ /\ applyFails < MaxApplyFails
          /\ applyFails' = applyFails + 1
          /\ pc' = "settle" /\ ctx' = "transfer"
          /\ UNCHANGED <<db, pending>>
    /\ UNCHANGED <<mode, file, crashes, opFails>>

---------------------------------------------------------------------------
\* settle(): decide from what is on disk. present() counts a partial file as present.
Settle ==
    /\ pc = "settle"
    /\ IF file["tmp"] # "none" /\ Mutation # "settleIgnoresTmp"
         THEN \* "the rename to dst has not happened": copy -> remove tmp, else rename tmp back to src
              /\ IF mode = "copy" \/ Mutation = "settleRemovesTmp"
                   THEN file' = [file EXCEPT !["tmp"] = "none"]
                   ELSE Rename("tmp", "src")
              /\ pc' = "settleDrop"
              /\ UNCHANGED <<db, pending, applyFails>>
         ELSE LET atDst == file["dst"] # "none"
                  \* a copy's src may be outside the library, so it is not looked at
                  atSrc == mode # "copy" /\ file["src"] # "none"
              IN  \/ /\ ~atSrc /\ atDst                         \* (false, true) => finish()
                     /\ \/ FinishCommit /\ UNCHANGED applyFails
                        \/ /\ applyFails < MaxApplyFails
                           /\ applyFails' = applyFails + 1
                           /\ pc' = "applyErr"                  \* Err: the op stays pending
                           /\ UNCHANGED <<db, pending>>
                  \/ /\ atSrc /\ ~atDst                         \* (true, false) => drop_op()
                     /\ pending' = FALSE /\ pc' = "done"
                     /\ UNCHANGED <<db, applyFails>>
                  \/ /\ ~atSrc /\ ~atDst /\ mode = "copy"       \* (false, false) if op.copy => drop_op()
                     /\ pending' = FALSE /\ pc' = "done"
                     /\ UNCHANGED <<db, applyFails>>
                  \/ /\ ~((~atSrc /\ atDst) \/ (atSrc /\ ~atDst) \/ (~atSrc /\ ~atDst /\ mode = "copy"))
                     /\ pc' = "left"                            \* Ok(false): left for the user
                     /\ UNCHANGED <<db, pending, applyFails>>
              /\ UNCHANGED file
    /\ UNCHANGED <<mode, ctx, crashes, opFails>>

\* settle(): drop_op() after handling tmp, as its own statement
SettleDrop ==
    /\ pc = "settleDrop"
    /\ pending' = FALSE /\ pc' = "done"
    /\ UNCHANGED <<mode, file, db, ctx, counters>>

\* library::connect() -> recover(): settle every row left in pending_ops
Recover ==
    /\ pc = "recover"
    /\ ctx' = "recovery"
    /\ pc' = IF pending THEN "settle" ELSE "done"
    /\ UNCHANGED <<mode, file, pending, db, counters>>

\* The user quits and opens the library again after an operation was left pending.
Reopen ==
    /\ pc \in {"applyErr", "left"}
    /\ pc' = "recover"
    /\ UNCHANGED <<mode, file, pending, db, ctx, counters>>

\* The process dies at any point. Only durable state survives.
Crash ==
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ pc' = "recover"
    /\ UNCHANGED <<mode, file, pending, db, ctx, applyFails, opFails>>

Progress ==
    \/ Record \/ RecordLate \/ RenameSrcDst \/ RenameSrcTmp \/ CopyBegin \/ CopyEnd
    \/ RenameTmpDst \/ OpFails \/ Finish \/ ApplyAfterDrop
    \/ Settle \/ SettleDrop \/ Recover \/ Reopen

Next == Progress \/ Crash

Spec == Init /\ [][Next]_vars /\ WF_vars(Progress)

---------------------------------------------------------------------------
TypeOK ==
    /\ mode \in Modes
    /\ file \in [Locs -> Contents]
    /\ pending \in BOOLEAN
    /\ db \in {"src", "dst", "none"}

\* The image is never lost: a move keeps exactly one whole copy somewhere,
\* and a copy never touches the original.
NoLoss ==
    IF mode = "copy"
      THEN file["src"] = "full"
      ELSE Cardinality({l \in Locs : file[l] = "full"}) = 1

\* The final name never holds a half-written file.
NoPartialAtDst == file["dst"] # "partial"

\* With no pending_ops row, the DB and the disk agree and no temporary file is left.
\* (An imported file at dst with no row yet is allowed: FR-104 registers it.)
SettledConsistent ==
    ~pending =>
        /\ file["tmp"] = "none"
        /\ IF mode = "copy"
             THEN db = "dst" => file["dst"] = "full"
             ELSE file[db] = "full"

\* With nobody else touching the files, settle() can always decide.
NeverUndecided == pc # "left"

\* Once crashes and failures stop, the operation ends with no pending_ops row.
EventuallySettled == <>[](~pending /\ pc = "done")
=============================================================================
