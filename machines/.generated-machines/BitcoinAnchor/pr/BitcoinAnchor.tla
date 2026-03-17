---- MODULE BitcoinAnchor ----
EXTENDS FiniteSets, Integers, TLC

\* Generated. Treat as a build artifact.
Null == "__NULL__"

CONSTANTS Anchors

VARIABLES status, chainTxId, fingerprintLocked, metadataLocked, legalHold, actor

vars == <<status, chainTxId, fingerprintLocked, metadataLocked, legalHold, actor>>

TypeOK ==
  /\ status \in [Anchors -> {"PENDING", "PENDING_CHAIN", "SECURED", "REVOKED"}]
  /\ chainTxId \in [Anchors -> {"has_tx"} \cup {Null}]
  /\ fingerprintLocked \in [Anchors -> BOOLEAN]
  /\ metadataLocked \in [Anchors -> BOOLEAN]
  /\ legalHold \in [Anchors -> BOOLEAN]
  /\ actor \in [Anchors -> {"client", "worker"}]

securedRequiresChainTx ==
  \A a \in Anchors : (~(status[a] = "SECURED")) \/ (chainTxId[a] = "has_tx")
fingerprintImmutableAfterPending ==
  \A a \in Anchors : (status[a] = "PENDING") \/ (fingerprintLocked[a])
revokedIsTerminal ==
  \A a \in Anchors : (~(status[a] = "REVOKED")) \/ (chainTxId[a] = "has_tx")
metadataImmutableAfterSecured ==
  \A a \in Anchors : (~(status[a] \in {"SECURED", "REVOKED"})) \/ (metadataLocked[a])
onlyWorkerSecures ==
  \A a \in Anchors : (~(status[a] = "SECURED")) \/ (actor[a] = "worker")
legalHoldPreventsSecuredToRevoked ==
  \A a \in Anchors : (~(legalHold[a])) \/ (~(status[a] = "PENDING"))

workerPickUp(a) ==
  /\ a \in Anchors
  /\ status[a] = "PENDING"
  /\ status' = [status EXCEPT ![a] = "PENDING_CHAIN"]
  /\ actor' = [actor EXCEPT ![a] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold>>
chainSubmitSuccess(a) ==
  /\ a \in Anchors
  /\ (status[a] = "PENDING_CHAIN") /\ (actor[a] = "worker")
  /\ status' = [status EXCEPT ![a] = "SECURED"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = "has_tx"]
  /\ metadataLocked' = [metadataLocked EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<fingerprintLocked, legalHold, actor>>
chainSubmitFail(a) ==
  /\ a \in Anchors
  /\ (status[a] = "PENDING_CHAIN") /\ (actor[a] = "worker")
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold>>
revoke(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SECURED") /\ (~(legalHold[a]))
  /\ status' = [status EXCEPT ![a] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold, actor>>
placeLegalHold(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"SECURED", "REVOKED"}) /\ (~(legalHold[a]))
  /\ legalHold' = [legalHold EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor>>
removeLegalHold(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"SECURED", "REVOKED"}) /\ (legalHold[a])
  /\ legalHold' = [legalHold EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor>>

Action_workerPickUp_1 ==
  /\ status["a1"] = "PENDING"
  /\ status' = [status EXCEPT !["a1"] = "PENDING_CHAIN"]
  /\ actor' = [actor EXCEPT !["a1"] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold>>
Action_workerPickUp_2 ==
  /\ status["a2"] = "PENDING"
  /\ status' = [status EXCEPT !["a2"] = "PENDING_CHAIN"]
  /\ actor' = [actor EXCEPT !["a2"] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold>>
Action_chainSubmitSuccess_1 ==
  /\ (status["a1"] = "PENDING_CHAIN") /\ (actor["a1"] = "worker")
  /\ status' = [status EXCEPT !["a1"] = "SECURED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = "has_tx"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<fingerprintLocked, legalHold, actor>>
Action_chainSubmitSuccess_2 ==
  /\ (status["a2"] = "PENDING_CHAIN") /\ (actor["a2"] = "worker")
  /\ status' = [status EXCEPT !["a2"] = "SECURED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = "has_tx"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<fingerprintLocked, legalHold, actor>>
Action_chainSubmitFail_1 ==
  /\ (status["a1"] = "PENDING_CHAIN") /\ (actor["a1"] = "worker")
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold>>
Action_chainSubmitFail_2 ==
  /\ (status["a2"] = "PENDING_CHAIN") /\ (actor["a2"] = "worker")
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold>>
Action_revoke_1 ==
  /\ (status["a1"] = "SECURED") /\ (~(legalHold["a1"]))
  /\ status' = [status EXCEPT !["a1"] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold, actor>>
Action_revoke_2 ==
  /\ (status["a2"] = "SECURED") /\ (~(legalHold["a2"]))
  /\ status' = [status EXCEPT !["a2"] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold, actor>>
Action_placeLegalHold_1 ==
  /\ (status["a1"] \in {"SECURED", "REVOKED"}) /\ (~(legalHold["a1"]))
  /\ legalHold' = [legalHold EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor>>
Action_placeLegalHold_2 ==
  /\ (status["a2"] \in {"SECURED", "REVOKED"}) /\ (~(legalHold["a2"]))
  /\ legalHold' = [legalHold EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor>>
Action_removeLegalHold_1 ==
  /\ (status["a1"] \in {"SECURED", "REVOKED"}) /\ (legalHold["a1"])
  /\ legalHold' = [legalHold EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor>>
Action_removeLegalHold_2 ==
  /\ (status["a2"] \in {"SECURED", "REVOKED"}) /\ (legalHold["a2"])
  /\ legalHold' = [legalHold EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor>>

Init ==
  /\ status = [x \in Anchors |-> "PENDING"]
  /\ chainTxId = [x \in Anchors |-> Null]
  /\ fingerprintLocked = [x \in Anchors |-> FALSE]
  /\ metadataLocked = [x \in Anchors |-> FALSE]
  /\ legalHold = [x \in Anchors |-> FALSE]
  /\ actor = [x \in Anchors |-> "client"]

Next ==
  \/ \E a \in Anchors : workerPickUp(a)
  \/ \E a \in Anchors : chainSubmitSuccess(a)
  \/ \E a \in Anchors : chainSubmitFail(a)
  \/ \E a \in Anchors : revoke(a)
  \/ \E a \in Anchors : placeLegalHold(a)
  \/ \E a \in Anchors : removeLegalHold(a)

EquivalenceNext ==
  \/ Action_workerPickUp_1
  \/ Action_workerPickUp_2
  \/ Action_chainSubmitSuccess_1
  \/ Action_chainSubmitSuccess_2
  \/ Action_chainSubmitFail_1
  \/ Action_chainSubmitFail_2
  \/ Action_revoke_1
  \/ Action_revoke_2
  \/ Action_placeLegalHold_1
  \/ Action_placeLegalHold_2
  \/ Action_removeLegalHold_1
  \/ Action_removeLegalHold_2

Spec == Init /\ [][Next]_vars
EquivalenceSpec == Init /\ [][EquivalenceNext]_vars

====