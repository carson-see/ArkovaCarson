---- MODULE BitcoinAnchor ----
EXTENDS FiniteSets, Integers, TLC

\* Generated. Treat as a build artifact.
Null == "__NULL__"

CONSTANTS Anchors

VARIABLES status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery

vars == <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>

TypeOK ==
  /\ status \in [Anchors -> {"PENDING", "BROADCASTING", "SUBMITTED", "SECURED", "REVOKED", "SUPERSEDED"}]
  /\ chainTxId \in [Anchors -> {"has_tx"} \cup {Null}]
  /\ fingerprintLocked \in [Anchors -> BOOLEAN]
  /\ metadataLocked \in [Anchors -> BOOLEAN]
  /\ credentialTypeLocked \in [Anchors -> BOOLEAN]
  /\ legalHold \in [Anchors -> BOOLEAN]
  /\ actor \in [Anchors -> {"client", "worker"}]
  /\ intentPersisted \in [Anchors -> BOOLEAN]
  /\ journalRecovery \in [Anchors -> {"NONE", "PENDING", "HELD"}]

securedRequiresChainTx ==
  \A a \in Anchors : (~(status[a] = "SECURED")) \/ (chainTxId[a] = "has_tx")
submittedRequiresChainTx ==
  \A a \in Anchors : (~(status[a] = "SUBMITTED")) \/ (chainTxId[a] = "has_tx")
broadcastingIntentChainTxCoupling ==
  \A a \in Anchors : (~(status[a] = "BROADCASTING")) \/ (((chainTxId[a] = "has_tx") /\ (intentPersisted[a])) \/ ((chainTxId[a] = Null) /\ (~(intentPersisted[a]))))
intentOnlyWhileBroadcasting ==
  \A a \in Anchors : (~(intentPersisted[a])) \/ (status[a] = "BROADCASTING")
intentRequiresWorkerActor ==
  \A a \in Anchors : (~(intentPersisted[a])) \/ (actor[a] = "worker")
journalOnlyWhileRecoverable ==
  \A a \in Anchors : (journalRecovery[a] = "NONE") \/ (status[a] \in {"BROADCASTING", "SUBMITTED", "SECURED"})
journalRequiresWorkerActor ==
  \A a \in Anchors : (journalRecovery[a] = "NONE") \/ (actor[a] = "worker")
intentRequiresJournalProtection ==
  \A a \in Anchors : (~(intentPersisted[a])) \/ (journalRecovery[a] \in {"PENDING", "HELD"})
fingerprintImmutableAfterPending ==
  \A a \in Anchors : (status[a] = "PENDING") \/ (fingerprintLocked[a])
revokedRequiresChainTx ==
  \A a \in Anchors : (~(status[a] = "REVOKED")) \/ (chainTxId[a] = "has_tx")
metadataImmutableAfterSecured ==
  \A a \in Anchors : (~(status[a] \in {"SECURED", "REVOKED", "SUPERSEDED"})) \/ (metadataLocked[a])
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
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, intentPersisted, journalRecovery>>
workerBroadcast(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker") /\ (~(intentPersisted[a])) /\ (journalRecovery[a] = "NONE")
  /\ status' = [status EXCEPT ![a] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = "has_tx"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
persistTxidJournal(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker") /\ (chainTxId[a] = Null) /\ (~(intentPersisted[a])) /\ (journalRecovery[a] = "NONE")
  /\ journalRecovery' = [journalRecovery EXCEPT ![a] = "PENDING"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted>>
persistBroadcastIntent(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker") /\ (chainTxId[a] = Null) /\ (~(intentPersisted[a])) /\ (journalRecovery[a] \in {"PENDING", "HELD"})
  /\ chainTxId' = [chainTxId EXCEPT ![a] = "has_tx"]
  /\ intentPersisted' = [intentPersisted EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<status, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, journalRecovery>>
broadcastResumeFinalize(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker") /\ (intentPersisted[a]) /\ (chainTxId[a] = "has_tx") /\ (journalRecovery[a] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT ![a] = "SUBMITTED"]
  /\ intentPersisted' = [intentPersisted EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, journalRecovery>>
journalHold(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"BROADCASTING", "SUBMITTED", "SECURED"}) /\ (actor[a] = "worker") /\ (journalRecovery[a] \in {"PENDING", "HELD"})
  /\ journalRecovery' = [journalRecovery EXCEPT ![a] = "HELD"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted>>
journalAdopt(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"BROADCASTING", "SUBMITTED"}) /\ (actor[a] = "worker") /\ (journalRecovery[a] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT ![a] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = "has_tx"]
  /\ intentPersisted' = [intentPersisted EXCEPT ![a] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT ![a] = "NONE"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
journalAdoptSecured(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SECURED") /\ (actor[a] = "worker") /\ (chainTxId[a] = "has_tx") /\ (journalRecovery[a] \in {"PENDING", "HELD"})
  /\ intentPersisted' = [intentPersisted EXCEPT ![a] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT ![a] = "NONE"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
journalRevert(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker") /\ (journalRecovery[a] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = Null]
  /\ intentPersisted' = [intentPersisted EXCEPT ![a] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT ![a] = "NONE"]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold>>
journalPersisted(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"SUBMITTED", "SECURED"}) /\ (actor[a] = "worker") /\ (chainTxId[a] = "has_tx") /\ (~(intentPersisted[a])) /\ (journalRecovery[a] \in {"PENDING", "HELD"})
  /\ journalRecovery' = [journalRecovery EXCEPT ![a] = "NONE"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted>>
broadcastIntentReject(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker") /\ (intentPersisted[a]) /\ (journalRecovery[a] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = Null]
  /\ intentPersisted' = [intentPersisted EXCEPT ![a] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT ![a] = "NONE"]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold>>
chainConfirm(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SUBMITTED") /\ (actor[a] = "worker") /\ (chainTxId[a] = "has_tx")
  /\ status' = [status EXCEPT ![a] = "SECURED"]
  /\ metadataLocked' = [metadataLocked EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
broadcastFail(a) ==
  /\ a \in Anchors
  /\ (status[a] = "BROADCASTING") /\ (actor[a] = "worker") /\ (~(intentPersisted[a])) /\ (journalRecovery[a] = "NONE")
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, intentPersisted, journalRecovery>>
chainSubmitFail(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SUBMITTED") /\ (actor[a] = "worker") /\ (~(legalHold[a])) /\ (journalRecovery[a] = "NONE")
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = Null]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold, intentPersisted, journalRecovery>>
chainSubmitAbandon(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SUBMITTED") /\ (actor[a] = "worker") /\ (~(legalHold[a])) /\ (journalRecovery[a] = "NONE")
  /\ status' = [status EXCEPT ![a] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT ![a] = Null]
  /\ actor' = [actor EXCEPT ![a] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold, intentPersisted, journalRecovery>>
revoke(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SECURED") /\ (~(legalHold[a])) /\ (journalRecovery[a] = "NONE")
  /\ status' = [status EXCEPT ![a] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
placeLegalHold(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (~(legalHold[a]))
  /\ legalHold' = [legalHold EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor, intentPersisted, journalRecovery>>
removeLegalHold(a) ==
  /\ a \in Anchors
  /\ (status[a] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (legalHold[a])
  /\ legalHold' = [legalHold EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor, intentPersisted, journalRecovery>>
supersede(a) ==
  /\ a \in Anchors
  /\ (~(status[a] \in {"REVOKED", "SUPERSEDED"})) /\ (~(legalHold[a]))
  /\ status' = [status EXCEPT ![a] = "SUPERSEDED"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT ![a] = TRUE]
  /\ metadataLocked' = [metadataLocked EXCEPT ![a] = TRUE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT ![a] = TRUE]
  /\ intentPersisted' = [intentPersisted EXCEPT ![a] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT ![a] = "NONE"]
  /\ UNCHANGED <<chainTxId, legalHold, actor>>
reorgDetected(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SECURED") /\ (actor[a] = "worker") /\ (chainTxId[a] = "has_tx") /\ (~(legalHold[a]))
  /\ status' = [status EXCEPT ![a] = "SUBMITTED"]
  /\ metadataLocked' = [metadataLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
reorgSameHeightRevert(a) ==
  /\ a \in Anchors
  /\ (status[a] = "SECURED") /\ (actor[a] = "worker") /\ (chainTxId[a] = "has_tx") /\ (~(legalHold[a]))
  /\ status' = [status EXCEPT ![a] = "SUBMITTED"]
  /\ metadataLocked' = [metadataLocked EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>

Action_workerClaim_1 ==
  /\ status["a1"] = "PENDING"
  /\ status' = [status EXCEPT !["a1"] = "BROADCASTING"]
  /\ actor' = [actor EXCEPT !["a1"] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = TRUE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, intentPersisted, journalRecovery>>
Action_workerClaim_2 ==
  /\ status["a2"] = "PENDING"
  /\ status' = [status EXCEPT !["a2"] = "BROADCASTING"]
  /\ actor' = [actor EXCEPT !["a2"] = "worker"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = TRUE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, intentPersisted, journalRecovery>>
Action_workerBroadcast_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker") /\ (~(intentPersisted["a1"])) /\ (journalRecovery["a1"] = "NONE")
  /\ status' = [status EXCEPT !["a1"] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = "has_tx"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
Action_workerBroadcast_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker") /\ (~(intentPersisted["a2"])) /\ (journalRecovery["a2"] = "NONE")
  /\ status' = [status EXCEPT !["a2"] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = "has_tx"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
Action_persistTxidJournal_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = Null) /\ (~(intentPersisted["a1"])) /\ (journalRecovery["a1"] = "NONE")
  /\ journalRecovery' = [journalRecovery EXCEPT !["a1"] = "PENDING"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted>>
Action_persistTxidJournal_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = Null) /\ (~(intentPersisted["a2"])) /\ (journalRecovery["a2"] = "NONE")
  /\ journalRecovery' = [journalRecovery EXCEPT !["a2"] = "PENDING"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted>>
Action_persistBroadcastIntent_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = Null) /\ (~(intentPersisted["a1"])) /\ (journalRecovery["a1"] \in {"PENDING", "HELD"})
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = "has_tx"]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<status, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, journalRecovery>>
Action_persistBroadcastIntent_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = Null) /\ (~(intentPersisted["a2"])) /\ (journalRecovery["a2"] \in {"PENDING", "HELD"})
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = "has_tx"]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<status, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, journalRecovery>>
Action_broadcastResumeFinalize_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker") /\ (intentPersisted["a1"]) /\ (chainTxId["a1"] = "has_tx") /\ (journalRecovery["a1"] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT !["a1"] = "SUBMITTED"]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, journalRecovery>>
Action_broadcastResumeFinalize_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker") /\ (intentPersisted["a2"]) /\ (chainTxId["a2"] = "has_tx") /\ (journalRecovery["a2"] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT !["a2"] = "SUBMITTED"]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, journalRecovery>>
Action_journalHold_1 ==
  /\ (status["a1"] \in {"BROADCASTING", "SUBMITTED", "SECURED"}) /\ (actor["a1"] = "worker") /\ (journalRecovery["a1"] \in {"PENDING", "HELD"})
  /\ journalRecovery' = [journalRecovery EXCEPT !["a1"] = "HELD"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted>>
Action_journalHold_2 ==
  /\ (status["a2"] \in {"BROADCASTING", "SUBMITTED", "SECURED"}) /\ (actor["a2"] = "worker") /\ (journalRecovery["a2"] \in {"PENDING", "HELD"})
  /\ journalRecovery' = [journalRecovery EXCEPT !["a2"] = "HELD"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted>>
Action_journalAdopt_1 ==
  /\ (status["a1"] \in {"BROADCASTING", "SUBMITTED"}) /\ (actor["a1"] = "worker") /\ (journalRecovery["a1"] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT !["a1"] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = "has_tx"]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a1"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a1"] = "NONE"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
Action_journalAdopt_2 ==
  /\ (status["a2"] \in {"BROADCASTING", "SUBMITTED"}) /\ (actor["a2"] = "worker") /\ (journalRecovery["a2"] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT !["a2"] = "SUBMITTED"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = "has_tx"]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a2"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a2"] = "NONE"]
  /\ UNCHANGED <<fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
Action_journalAdoptSecured_1 ==
  /\ (status["a1"] = "SECURED") /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = "has_tx") /\ (journalRecovery["a1"] \in {"PENDING", "HELD"})
  /\ intentPersisted' = [intentPersisted EXCEPT !["a1"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a1"] = "NONE"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
Action_journalAdoptSecured_2 ==
  /\ (status["a2"] = "SECURED") /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = "has_tx") /\ (journalRecovery["a2"] \in {"PENDING", "HELD"})
  /\ intentPersisted' = [intentPersisted EXCEPT !["a2"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a2"] = "NONE"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor>>
Action_journalRevert_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker") /\ (journalRecovery["a1"] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = Null]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a1"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a1"] = "NONE"]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold>>
Action_journalRevert_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker") /\ (journalRecovery["a2"] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = Null]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a2"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a2"] = "NONE"]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold>>
Action_journalPersisted_1 ==
  /\ (status["a1"] \in {"SUBMITTED", "SECURED"}) /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = "has_tx") /\ (~(intentPersisted["a1"])) /\ (journalRecovery["a1"] \in {"PENDING", "HELD"})
  /\ journalRecovery' = [journalRecovery EXCEPT !["a1"] = "NONE"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted>>
Action_journalPersisted_2 ==
  /\ (status["a2"] \in {"SUBMITTED", "SECURED"}) /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = "has_tx") /\ (~(intentPersisted["a2"])) /\ (journalRecovery["a2"] \in {"PENDING", "HELD"})
  /\ journalRecovery' = [journalRecovery EXCEPT !["a2"] = "NONE"]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted>>
Action_broadcastIntentReject_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker") /\ (intentPersisted["a1"]) /\ (journalRecovery["a1"] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = Null]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a1"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a1"] = "NONE"]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold>>
Action_broadcastIntentReject_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker") /\ (intentPersisted["a2"]) /\ (journalRecovery["a2"] \in {"PENDING", "HELD"})
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = Null]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a2"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a2"] = "NONE"]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold>>
Action_chainConfirm_1 ==
  /\ (status["a1"] = "SUBMITTED") /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = "has_tx")
  /\ status' = [status EXCEPT !["a1"] = "SECURED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
Action_chainConfirm_2 ==
  /\ (status["a2"] = "SUBMITTED") /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = "has_tx")
  /\ status' = [status EXCEPT !["a2"] = "SECURED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
Action_broadcastFail_1 ==
  /\ (status["a1"] = "BROADCASTING") /\ (actor["a1"] = "worker") /\ (~(intentPersisted["a1"])) /\ (journalRecovery["a1"] = "NONE")
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, intentPersisted, journalRecovery>>
Action_broadcastFail_2 ==
  /\ (status["a2"] = "BROADCASTING") /\ (actor["a2"] = "worker") /\ (~(intentPersisted["a2"])) /\ (journalRecovery["a2"] = "NONE")
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<chainTxId, metadataLocked, legalHold, intentPersisted, journalRecovery>>
Action_chainSubmitFail_1 ==
  /\ (status["a1"] = "SUBMITTED") /\ (actor["a1"] = "worker") /\ (~(legalHold["a1"])) /\ (journalRecovery["a1"] = "NONE")
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = Null]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold, intentPersisted, journalRecovery>>
Action_chainSubmitFail_2 ==
  /\ (status["a2"] = "SUBMITTED") /\ (actor["a2"] = "worker") /\ (~(legalHold["a2"])) /\ (journalRecovery["a2"] = "NONE")
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = Null]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold, intentPersisted, journalRecovery>>
Action_chainSubmitAbandon_1 ==
  /\ (status["a1"] = "SUBMITTED") /\ (actor["a1"] = "worker") /\ (~(legalHold["a1"])) /\ (journalRecovery["a1"] = "NONE")
  /\ status' = [status EXCEPT !["a1"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a1"] = Null]
  /\ actor' = [actor EXCEPT !["a1"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold, intentPersisted, journalRecovery>>
Action_chainSubmitAbandon_2 ==
  /\ (status["a2"] = "SUBMITTED") /\ (actor["a2"] = "worker") /\ (~(legalHold["a2"])) /\ (journalRecovery["a2"] = "NONE")
  /\ status' = [status EXCEPT !["a2"] = "PENDING"]
  /\ chainTxId' = [chainTxId EXCEPT !["a2"] = Null]
  /\ actor' = [actor EXCEPT !["a2"] = "client"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = FALSE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<metadataLocked, legalHold, intentPersisted, journalRecovery>>
Action_revoke_1 ==
  /\ (status["a1"] = "SECURED") /\ (~(legalHold["a1"])) /\ (journalRecovery["a1"] = "NONE")
  /\ status' = [status EXCEPT !["a1"] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
Action_revoke_2 ==
  /\ (status["a2"] = "SECURED") /\ (~(legalHold["a2"])) /\ (journalRecovery["a2"] = "NONE")
  /\ status' = [status EXCEPT !["a2"] = "REVOKED"]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
Action_placeLegalHold_1 ==
  /\ (status["a1"] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (~(legalHold["a1"]))
  /\ legalHold' = [legalHold EXCEPT !["a1"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor, intentPersisted, journalRecovery>>
Action_placeLegalHold_2 ==
  /\ (status["a2"] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (~(legalHold["a2"]))
  /\ legalHold' = [legalHold EXCEPT !["a2"] = TRUE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor, intentPersisted, journalRecovery>>
Action_removeLegalHold_1 ==
  /\ (status["a1"] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (legalHold["a1"])
  /\ legalHold' = [legalHold EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor, intentPersisted, journalRecovery>>
Action_removeLegalHold_2 ==
  /\ (status["a2"] \in {"SECURED", "REVOKED", "SUPERSEDED"}) /\ (legalHold["a2"])
  /\ legalHold' = [legalHold EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<status, chainTxId, fingerprintLocked, metadataLocked, credentialTypeLocked, actor, intentPersisted, journalRecovery>>
Action_supersede_1 ==
  /\ (~(status["a1"] \in {"REVOKED", "SUPERSEDED"})) /\ (~(legalHold["a1"]))
  /\ status' = [status EXCEPT !["a1"] = "SUPERSEDED"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a1"] = TRUE]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a1"] = TRUE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a1"] = TRUE]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a1"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a1"] = "NONE"]
  /\ UNCHANGED <<chainTxId, legalHold, actor>>
Action_supersede_2 ==
  /\ (~(status["a2"] \in {"REVOKED", "SUPERSEDED"})) /\ (~(legalHold["a2"]))
  /\ status' = [status EXCEPT !["a2"] = "SUPERSEDED"]
  /\ fingerprintLocked' = [fingerprintLocked EXCEPT !["a2"] = TRUE]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a2"] = TRUE]
  /\ credentialTypeLocked' = [credentialTypeLocked EXCEPT !["a2"] = TRUE]
  /\ intentPersisted' = [intentPersisted EXCEPT !["a2"] = FALSE]
  /\ journalRecovery' = [journalRecovery EXCEPT !["a2"] = "NONE"]
  /\ UNCHANGED <<chainTxId, legalHold, actor>>
Action_reorgDetected_1 ==
  /\ (status["a1"] = "SECURED") /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = "has_tx") /\ (~(legalHold["a1"]))
  /\ status' = [status EXCEPT !["a1"] = "SUBMITTED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
Action_reorgDetected_2 ==
  /\ (status["a2"] = "SECURED") /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = "has_tx") /\ (~(legalHold["a2"]))
  /\ status' = [status EXCEPT !["a2"] = "SUBMITTED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
Action_reorgSameHeightRevert_1 ==
  /\ (status["a1"] = "SECURED") /\ (actor["a1"] = "worker") /\ (chainTxId["a1"] = "has_tx") /\ (~(legalHold["a1"]))
  /\ status' = [status EXCEPT !["a1"] = "SUBMITTED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a1"] = FALSE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>
Action_reorgSameHeightRevert_2 ==
  /\ (status["a2"] = "SECURED") /\ (actor["a2"] = "worker") /\ (chainTxId["a2"] = "has_tx") /\ (~(legalHold["a2"]))
  /\ status' = [status EXCEPT !["a2"] = "SUBMITTED"]
  /\ metadataLocked' = [metadataLocked EXCEPT !["a2"] = FALSE]
  /\ UNCHANGED <<chainTxId, fingerprintLocked, credentialTypeLocked, legalHold, actor, intentPersisted, journalRecovery>>

Init ==
  /\ status = [x \in Anchors |-> "PENDING"]
  /\ chainTxId = [x \in Anchors |-> Null]
  /\ fingerprintLocked = [x \in Anchors |-> FALSE]
  /\ metadataLocked = [x \in Anchors |-> FALSE]
  /\ credentialTypeLocked = [x \in Anchors |-> FALSE]
  /\ legalHold = [x \in Anchors |-> FALSE]
  /\ actor = [x \in Anchors |-> "client"]
  /\ intentPersisted = [x \in Anchors |-> FALSE]
  /\ journalRecovery = [x \in Anchors |-> "NONE"]

Next ==
  \/ \E a \in Anchors : workerClaim(a)
  \/ \E a \in Anchors : workerBroadcast(a)
  \/ \E a \in Anchors : persistTxidJournal(a)
  \/ \E a \in Anchors : persistBroadcastIntent(a)
  \/ \E a \in Anchors : broadcastResumeFinalize(a)
  \/ \E a \in Anchors : journalHold(a)
  \/ \E a \in Anchors : journalAdopt(a)
  \/ \E a \in Anchors : journalAdoptSecured(a)
  \/ \E a \in Anchors : journalRevert(a)
  \/ \E a \in Anchors : journalPersisted(a)
  \/ \E a \in Anchors : broadcastIntentReject(a)
  \/ \E a \in Anchors : chainConfirm(a)
  \/ \E a \in Anchors : broadcastFail(a)
  \/ \E a \in Anchors : chainSubmitFail(a)
  \/ \E a \in Anchors : chainSubmitAbandon(a)
  \/ \E a \in Anchors : revoke(a)
  \/ \E a \in Anchors : placeLegalHold(a)
  \/ \E a \in Anchors : removeLegalHold(a)
  \/ \E a \in Anchors : supersede(a)
  \/ \E a \in Anchors : reorgDetected(a)
  \/ \E a \in Anchors : reorgSameHeightRevert(a)

EquivalenceNext ==
  \/ Action_workerClaim_1
  \/ Action_workerClaim_2
  \/ Action_workerBroadcast_1
  \/ Action_workerBroadcast_2
  \/ Action_persistTxidJournal_1
  \/ Action_persistTxidJournal_2
  \/ Action_persistBroadcastIntent_1
  \/ Action_persistBroadcastIntent_2
  \/ Action_broadcastResumeFinalize_1
  \/ Action_broadcastResumeFinalize_2
  \/ Action_journalHold_1
  \/ Action_journalHold_2
  \/ Action_journalAdopt_1
  \/ Action_journalAdopt_2
  \/ Action_journalAdoptSecured_1
  \/ Action_journalAdoptSecured_2
  \/ Action_journalRevert_1
  \/ Action_journalRevert_2
  \/ Action_journalPersisted_1
  \/ Action_journalPersisted_2
  \/ Action_broadcastIntentReject_1
  \/ Action_broadcastIntentReject_2
  \/ Action_chainConfirm_1
  \/ Action_chainConfirm_2
  \/ Action_broadcastFail_1
  \/ Action_broadcastFail_2
  \/ Action_chainSubmitFail_1
  \/ Action_chainSubmitFail_2
  \/ Action_chainSubmitAbandon_1
  \/ Action_chainSubmitAbandon_2
  \/ Action_revoke_1
  \/ Action_revoke_2
  \/ Action_placeLegalHold_1
  \/ Action_placeLegalHold_2
  \/ Action_removeLegalHold_1
  \/ Action_removeLegalHold_2
  \/ Action_supersede_1
  \/ Action_supersede_2
  \/ Action_reorgDetected_1
  \/ Action_reorgDetected_2
  \/ Action_reorgSameHeightRevert_1
  \/ Action_reorgSameHeightRevert_2

Spec == Init /\ [][Next]_vars
EquivalenceSpec == Init /\ [][EquivalenceNext]_vars

====