---- MODULE BitcoinAnchor ----
EXTENDS FiniteSets, Integers, TLC

\* Generated. Treat as a build artifact.
Null == "__NULL__"

CONSTANTS Anchors

VARIABLES status, chainTxId, fingerprintLocked, metadataLocked, legalHold, actor, softDeleted

vars == <<status, chainTxId, fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>

TypeOK ==
  /\ status \in [Anchors -> {"PENDING", "BROADCASTING", "SUBMITTED", "SECURED", "REVOKED", "SUPERSEDED"}]
  /\ chainTxId \in [Anchors -> {"has_tx"} \cup {Null}]
  /\ fingerprintLocked \in [Anchors -> BOOLEAN]
  /\ metadataLocked \in [Anchors -> BOOLEAN]
  /\ legalHold \in [Anchors -> BOOLEAN]
  /\ actor \in [Anchors -> {"client", "worker"}]
  /\ softDeleted \in [Anchors -> BOOLEAN]

securedRequiresChainTx ==
  \A a \in Anchors : (~(status[a] = "SECURED")) \/ (chainTxId[a] = "has_tx")
submittedRequiresChainTx ==
  \A a \in Anchors : (~(status[a] = "SUBMITTED")) \/ (chainTxId[a] = "has_tx")
broadcastingNoChainTx ==
  \A a \in Anchors : (~(status[a] = "BROADCASTING")) \/ (chainTxId[a] = Null)
fingerprintImmutableAfterPending ==
  \A a \in Anchors : (status[a] = "PENDING") \/ (fingerprintLocked[a])
revokedHasChainTx ==
  \A a \in Anchors : (~(status[a] = "REVOKED")) \/ (chainTxId[a] = "has_tx")
metadataImmutableAfterSecured ==
  \A a \in Anchors : (~(status[a] \in {"SECURED", "REVOKED"})) \/ (metadataLocked[a])
onlyWorkerSecures ==
  \A a \in Anchors : (~(status[a] = "SECURED")) \/ (actor[a] = "worker")
legalHoldPreventsSecuredToRevoked ==
  \A a \in Anchors : (~(legalHold[a])) \/ (~(status[a] = "PENDING"))

workerClaim(a) ==
  /\ a \in Anchors
  /\ status[a] = "PENDING"
  /\ status' = [status EXCEPT ![a] = "BROADCASTING"]
  /\ actor' = [actor EXCEPT ![a] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, softDeleted>>
workerBroadcast(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker")
  /\ status' = [status EXCEPT ![a] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = "has_tx"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>
chainConfirm(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SUBMITTED") /\ (actor[a] = "worker") /\ (chainTxId[a] = "has_tx")
  /\ status' = [status EXCEPT ![a] = "SECURED"]
  /\ metadataLocked' = [metadataLocked EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, legalHold, actor, softDeleted>>
broadcastFail(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker")
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, softDeleted>>
chainSubmitFail(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SUBMITTED") /\ (actor[a] = "worker")
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = Null]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold, softDeleted>>
reorgDetected(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SECURED") /\ (actor[a] = "worker") /\ (chainTxId[a] = "has_tx") /\ (~(legalHold[a]))
  /\ status' = [status EXCEPT ![a] = "SUBMITTED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>
revoke(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SECURED") /\ (~(legalHold[a]))
  /\ status' = [status EXCEPT ![a] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>
supersede(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"PENDING", "BROADCASTING", "SUBMITTED", "SECURED"}) /\ (~(legalHold[a]))
  /\ status' = [status EXCEPT ![a] = "SUPERSEDED"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, actor, softDeleted>>
placeLegalHold(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (~(legalHold[a]))
  /\ legalHold' = [legalHold EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor, softDeleted>>
removeLegalHold(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (legalHold[a])
  /\ legalHold' = [legalHold EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor, softDeleted>>
softDelete(a) ==
  /\ a \in Anchors
  /\ ~(softDeleted[a])
  /\ softDeleted' = [softDeleted EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, legalHold, actor>>

Action_workerClaim_1 ==
  /\ status["a1"] = "PENDING"
  /\ status' = [status EXCEPT !["a1"] = "BROADCASTING"]
  /\ actor' = [actor EXCEPT !["a1"] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, softDeleted>>
Action_workerClaim_2 ==
  /\ status["a2"] = "PENDING"
  /\ status' = [status EXCEPT !["a2"] = "BROADCASTING"]
  /\ actor' = [actor EXCEPT !["a2"] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, softDeleted>>
Action_workerBroadcast_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker")
  /\ status' = [status EXCEPT !["a1"] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = "has_tx"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>
Action_workerBroadcast_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker")
  /\ status' = [status EXCEPT !["a2"] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = "has_tx"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>
Action_chainConfirm_1 ==
  /\ (status["a1"] = "SUBMITTED") /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = "has_tx")
  /\ status' = [status EXCEPT !["a1"] = "SECURED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, legalHold, actor, softDeleted>>
Action_chainConfirm_2 ==
  /\ (status["a2"] = "SUBMITTED") /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = "has_tx")
  /\ status' = [status EXCEPT !["a2"] = "SECURED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, legalHold, actor, softDeleted>>
Action_broadcastFail_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker")
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, softDeleted>>
Action_broadcastFail_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker")
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, softDeleted>>
Action_chainSubmitFail_1 ==
  /\ (status["a1"] = "SUBMITTED") /\ (actor["a1"] = "worker")
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = Null]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold, softDeleted>>
Action_chainSubmitFail_2 ==
  /\ (status["a2"] = "SUBMITTED") /\ (actor["a2"] = "worker")
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = Null]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold, softDeleted>>
Action_reorgDetected_1 ==
  /\ (status["a1"] = "SECURED") /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = "has_tx") /\ (~(legalHold["a1"]))
  /\ status' = [status EXCEPT !["a1"] = "SUBMITTED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>
Action_reorgDetected_2 ==
  /\ (status["a2"] = "SECURED") /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = "has_tx") /\ (~(legalHold["a2"]))
  /\ status' = [status EXCEPT !["a2"] = "SUBMITTED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>
Action_revoke_1 ==
  /\ (status["a1"] = "SECURED") /\ (~(legalHold["a1"]))
  /\ status' = [status EXCEPT !["a1"] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>
Action_revoke_2 ==
  /\ (status["a2"] = "SECURED") /\ (~(legalHold["a2"]))
  /\ status' = [status EXCEPT !["a2"] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, legalHold, actor, softDeleted>>
Action_supersede_1 ==
  /\ (status["a1"] \in {"PENDING", "BROADCASTING", "SUBMITTED", "SECURED"}) /\ (~(legalHold["a1"]))
  /\ status' = [status EXCEPT !["a1"] = "SUPERSEDED"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, actor, softDeleted>>
Action_supersede_2 ==
  /\ (status["a2"] \in {"PENDING", "BROADCASTING", "SUBMITTED", "SECURED"}) /\ (~(legalHold["a2"]))
  /\ status' = [status EXCEPT !["a2"] = "SUPERSEDED"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, actor, softDeleted>>
Action_placeLegalHold_1 ==
  /\ (status["a1"] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (~(legalHold["a1"]))
  /\ legalHold' = [legalHold EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor, softDeleted>>
Action_placeLegalHold_2 ==
  /\ (status["a2"] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (~(legalHold["a2"]))
  /\ legalHold' = [legalHold EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor, softDeleted>>
Action_removeLegalHold_1 ==
  /\ (status["a1"] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (legalHold["a1"])
  /\ legalHold' = [legalHold EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor, softDeleted>>
Action_removeLegalHold_2 ==
  /\ (status["a2"] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (legalHold["a2"])
  /\ legalHold' = [legalHold EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, actor, softDeleted>>
Action_softDelete_1 ==
  /\ ~(softDeleted["a1"])
  /\ softDeleted' = [softDeleted EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, legalHold, actor>>
Action_softDelete_2 ==
  /\ ~(softDeleted["a2"])
  /\ softDeleted' = [softDeleted EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, legalHold, actor>>

Init ==
  /\ status = [x \in Anchors |-> "PENDING"]
  /\ chainTxId = [x \in Anchors |-> Null]
  /\ fingerprintLocked = [x \in Anchors |-> FALSE]
  /\ metadataLocked = [x \in Anchors |-> FALSE]
  /\ legalHold = [x \in Anchors |-> FALSE]
  /\ actor = [x \in Anchors |-> "client"]
  /\ softDeleted = [x \in Anchors |-> FALSE]

Next ==
  \/ \E a \in Anchors : workerClaim(a)
  \/ \E a \in Anchors : workerBroadcast(a)
  \/ \E a \in Anchors : chainConfirm(a)
  \/ \E a \in Anchors : broadcastFail(a)
  \/ \E a \in Anchors : chainSubmitFail(a)
  \/ \E a \in Anchors : reorgDetected(a)
  \/ \E a \in Anchors : revoke(a)
  \/ \E a \in Anchors : supersede(a)
  \/ \E a \in Anchors : placeLegalHold(a)
  \/ \E a \in Anchors : removeLegalHold(a)
  \/ \E a \in Anchors : softDelete(a)

EquivalenceNext ==
  \/ Action_workerClaim_1
  \/ Action_workerClaim_2
  \/ Action_workerBroadcast_1
  \/ Action_workerBroadcast_2
  \/ Action_chainConfirm_1
  \/ Action_chainConfirm_2
  \/ Action_broadcastFail_1
  \/ Action_broadcastFail_2
  \/ Action_chainSubmitFail_1
  \/ Action_chainSubmitFail_2
  \/ Action_reorgDetected_1
  \/ Action_reorgDetected_2
  \/ Action_revoke_1
  \/ Action_revoke_2
  \/ Action_supersede_1
  \/ Action_supersede_2
  \/ Action_placeLegalHold_1
  \/ Action_placeLegalHold_2
  \/ Action_removeLegalHold_1
  \/ Action_removeLegalHold_2
  \/ Action_softDelete_1
  \/ Action_softDelete_2

Spec == Init /\ [][Next]_vars
EquivalenceSpec == Init /\ [][EquivalenceNext]_vars

====