---- MODULE BitcoinAnchor ----
EXTENDS FiniteSets, Integers, TLC

\* Generated. Treat as a build artifact.
Null == "__NULL__"

CONSTANTS Anchors

VARIABLES status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor

vars == <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>

TypeOK ==
  /\ status \in [Anchors -> {"PENDING", "BROADCASTING", "SUBMITTED", "SECURED", "REVOKED"}]
  /\ chainTxId \in [Anchors -> {"has_tx"} \cup {Null}]
  /\ fingerprintLocked \in [Anchors -> BOOLEAN]
  /\ metadataLocked \in [Anchors -> BOOLEAN]
  /\ credentialTypeLocked \in [Anchors -> BOOLEAN]
  /\ legalHold \in [Anchors -> BOOLEAN]
  /\ actor \in [Anchors -> {"client", "worker"}]

securedRequiresChainTx ==
  \A a \in Anchors : (~(status[a] = "SECURED")) \/ (chainTxId[a] = "has_tx")
submittedRequiresChainTx ==
  \A a \in Anchors : (~(status[a] = "SUBMITTED")) \/ (chainTxId[a] = "has_tx")
broadcastingNoChainTx ==
  \A a \in Anchors : (~(status[a] = "BROADCASTING")) \/ (chainTxId[a] = Null)
fingerprintImmutableAfterPending ==
  \A a \in Anchors : (status[a] = "PENDING") \/ (fingerprintLocked[a])
revokedIsTerminal ==
  \A a \in Anchors : (~(status[a] = "REVOKED")) \/ (chainTxId[a] = "has_tx")
metadataImmutableAfterSecured ==
  \A a \in Anchors : (~(status[a] \in {"SECURED", "REVOKED"})) \/ (metadataLocked[a])
onlyWorkerSecures ==
  \A a \in Anchors : (~(status[a] = "SECURED")) \/ (actor[a] = "worker")
credentialTypeImmutableAfterPending ==
  \A a \in Anchors : (status[a] = "PENDING") \/ (credentialTypeLocked[a])
legalHoldPreventsSecuredToRevoked ==
  \A a \in Anchors : (~(legalHold[a])) \/ (~(status[a] = "PENDING"))

workerClaim(a) ==
  /\ a \in Anchors
  /\ status[a] = "PENDING"
  /\ status' = [status EXCEPT ![a] = "BROADCASTING"]
  /\ actor' = [actor EXCEPT ![a] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = TRUE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold>>
workerBroadcast(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker")
  /\ status' = [status EXCEPT ![a] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = "has_tx"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
chainConfirm(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SUBMITTED") /\ (actor[a] = "worker") /\ (chainTxId[a] = "has_tx")
  /\ status' = [status EXCEPT ![a] = "SECURED"]
  /\ metadataLocked' = [metadataLocked EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor>>
broadcastFail(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker")
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold>>
chainSubmitFail(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SUBMITTED") /\ (actor[a] = "worker")
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = Null]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold>>
revoke(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SECURED") /\ (~(legalHold[a]))
  /\ status' = [status EXCEPT ![a] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
placeLegalHold(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"SECURED", "REVOKED"}) /\ (~(legalHold[a]))
  /\ legalHold' = [legalHold EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor>>
removeLegalHold(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"SECURED", "REVOKED"}) /\ (legalHold[a])
  /\ legalHold' = [legalHold EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor>>

Action_workerClaim_1 ==
  /\ status["a1"] = "PENDING"
  /\ status' = [status EXCEPT !["a1"] = "BROADCASTING"]
  /\ actor' = [actor EXCEPT !["a1"] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = TRUE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold>>
Action_workerClaim_2 ==
  /\ status["a2"] = "PENDING"
  /\ status' = [status EXCEPT !["a2"] = "BROADCASTING"]
  /\ actor' = [actor EXCEPT !["a2"] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = TRUE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold>>
Action_workerBroadcast_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker")
  /\ status' = [status EXCEPT !["a1"] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = "has_tx"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
Action_workerBroadcast_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker")
  /\ status' = [status EXCEPT !["a2"] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = "has_tx"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
Action_chainConfirm_1 ==
  /\ (status["a1"] = "SUBMITTED") /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = "has_tx")
  /\ status' = [status EXCEPT !["a1"] = "SECURED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor>>
Action_chainConfirm_2 ==
  /\ (status["a2"] = "SUBMITTED") /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = "has_tx")
  /\ status' = [status EXCEPT !["a2"] = "SECURED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor>>
Action_broadcastFail_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker")
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold>>
Action_broadcastFail_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker")
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold>>
Action_chainSubmitFail_1 ==
  /\ (status["a1"] = "SUBMITTED") /\ (actor["a1"] = "worker")
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = Null]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold>>
Action_chainSubmitFail_2 ==
  /\ (status["a2"] = "SUBMITTED") /\ (actor["a2"] = "worker")
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = Null]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold>>
Action_revoke_1 ==
  /\ (status["a1"] = "SECURED") /\ (~(legalHold["a1"]))
  /\ status' = [status EXCEPT !["a1"] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
Action_revoke_2 ==
  /\ (status["a2"] = "SECURED") /\ (~(legalHold["a2"]))
  /\ status' = [status EXCEPT !["a2"] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
Action_placeLegalHold_1 ==
  /\ (status["a1"] \in {"SECURED", "REVOKED"}) /\ (~(legalHold["a1"]))
  /\ legalHold' = [legalHold EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor>>
Action_placeLegalHold_2 ==
  /\ (status["a2"] \in {"SECURED", "REVOKED"}) /\ (~(legalHold["a2"]))
  /\ legalHold' = [legalHold EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor>>
Action_removeLegalHold_1 ==
  /\ (status["a1"] \in {"SECURED", "REVOKED"}) /\ (legalHold["a1"])
  /\ legalHold' = [legalHold EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor>>
Action_removeLegalHold_2 ==
  /\ (status["a2"] \in {"SECURED", "REVOKED"}) /\ (legalHold["a2"])
  /\ legalHold' = [legalHold EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor>>

Init ==
  /\ status = [x \in Anchors |-> "PENDING"]
  /\ chainTxId = [x \in Anchors |-> Null]
  /\ fingerprintLocked = [x \in Anchors |-> FALSE]
  /\ metadataLocked = [x \in Anchors |-> FALSE]
  /\ credentialTypeLocked = [x \in Anchors |-> FALSE]
  /\ legalHold = [x \in Anchors |-> FALSE]
  /\ actor = [x \in Anchors |-> "client"]

Next ==
  \/ \E a \in Anchors : workerClaim(a)
  \/ \E a \in Anchors : workerBroadcast(a)
  \/ \E a \in Anchors : chainConfirm(a)
  \/ \E a \in Anchors : broadcastFail(a)
  \/ \E a \in Anchors : chainSubmitFail(a)
  \/ \E a \in Anchors : revoke(a)
  \/ \E a \in Anchors : placeLegalHold(a)
  \/ \E a \in Anchors : removeLegalHold(a)

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
  \/ Action_revoke_1
  \/ Action_revoke_2
  \/ Action_placeLegalHold_1
  \/ Action_placeLegalHold_2
  \/ Action_removeLegalHold_1
  \/ Action_removeLegalHold_2

Spec == Init /\ [][Next]_vars
EquivalenceSpec == Init /\ [][EquivalenceNext]_vars

====