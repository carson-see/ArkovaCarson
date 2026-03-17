// Generated. Do not edit.
// machine: BitcoinAnchor
// machineSha256: 7c5ec24a9674009bae08065c8be39de1127896a257301bd61d9dac0edef9478a

import type { MachineDef } from "tla-precheck";
import {
  applyGeneratedAction,
  type AdapterSqlClient,
  type AdapterWriteResult,
  type GeneratedAdapterSpec
} from "tla-precheck/db/adapterRuntime";

const machine = {
  "version": 2,
  "moduleName": "BitcoinAnchor",
  "variables": {
    "status": {
      "kind": "map",
      "domain": "Anchors",
      "codomain": {
        "kind": "enum",
        "values": [
          "PENDING",
          "PENDING_CHAIN",
          "SECURED",
          "REVOKED"
        ]
      },
      "initial": {
        "kind": "lit",
        "value": "PENDING"
      }
    },
    "chainTxId": {
      "kind": "map",
      "domain": "Anchors",
      "codomain": {
        "kind": "option",
        "value": {
          "kind": "enum",
          "values": [
            "has_tx"
          ]
        }
      },
      "initial": {
        "kind": "lit",
        "value": null
      }
    },
    "fingerprintLocked": {
      "kind": "map",
      "domain": "Anchors",
      "codomain": {
        "kind": "boolean"
      },
      "initial": {
        "kind": "lit",
        "value": false
      }
    },
    "metadataLocked": {
      "kind": "map",
      "domain": "Anchors",
      "codomain": {
        "kind": "boolean"
      },
      "initial": {
        "kind": "lit",
        "value": false
      }
    },
    "legalHold": {
      "kind": "map",
      "domain": "Anchors",
      "codomain": {
        "kind": "boolean"
      },
      "initial": {
        "kind": "lit",
        "value": false
      }
    },
    "actor": {
      "kind": "map",
      "domain": "Anchors",
      "codomain": {
        "kind": "enum",
        "values": [
          "client",
          "worker"
        ]
      },
      "initial": {
        "kind": "lit",
        "value": "client"
      }
    }
  },
  "actions": {
    "workerPickUp": {
      "params": {
        "a": "Anchors"
      },
      "guard": {
        "kind": "eq",
        "left": {
          "kind": "index",
          "target": {
            "kind": "var",
            "name": "status"
          },
          "key": {
            "kind": "param",
            "name": "a"
          }
        },
        "right": {
          "kind": "lit",
          "value": "PENDING"
        }
      },
      "updates": [
        {
          "kind": "setMap",
          "name": "status",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": "PENDING_CHAIN"
          }
        },
        {
          "kind": "setMap",
          "name": "actor",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": "worker"
          }
        },
        {
          "kind": "setMap",
          "name": "fingerprintLocked",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": true
          }
        }
      ]
    },
    "chainSubmitSuccess": {
      "params": {
        "a": "Anchors"
      },
      "guard": {
        "kind": "and",
        "values": [
          {
            "kind": "eq",
            "left": {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "status"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            },
            "right": {
              "kind": "lit",
              "value": "PENDING_CHAIN"
            }
          },
          {
            "kind": "eq",
            "left": {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "actor"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            },
            "right": {
              "kind": "lit",
              "value": "worker"
            }
          }
        ]
      },
      "updates": [
        {
          "kind": "setMap",
          "name": "status",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": "SECURED"
          }
        },
        {
          "kind": "setMap",
          "name": "chainTxId",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": "has_tx"
          }
        },
        {
          "kind": "setMap",
          "name": "metadataLocked",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": true
          }
        }
      ]
    },
    "chainSubmitFail": {
      "params": {
        "a": "Anchors"
      },
      "guard": {
        "kind": "and",
        "values": [
          {
            "kind": "eq",
            "left": {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "status"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            },
            "right": {
              "kind": "lit",
              "value": "PENDING_CHAIN"
            }
          },
          {
            "kind": "eq",
            "left": {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "actor"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            },
            "right": {
              "kind": "lit",
              "value": "worker"
            }
          }
        ]
      },
      "updates": [
        {
          "kind": "setMap",
          "name": "status",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": "PENDING"
          }
        },
        {
          "kind": "setMap",
          "name": "actor",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": "client"
          }
        }
      ]
    },
    "revoke": {
      "params": {
        "a": "Anchors"
      },
      "guard": {
        "kind": "and",
        "values": [
          {
            "kind": "eq",
            "left": {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "status"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            },
            "right": {
              "kind": "lit",
              "value": "SECURED"
            }
          },
          {
            "kind": "not",
            "value": {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "legalHold"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            }
          }
        ]
      },
      "updates": [
        {
          "kind": "setMap",
          "name": "status",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": "REVOKED"
          }
        }
      ]
    },
    "placeLegalHold": {
      "params": {
        "a": "Anchors"
      },
      "guard": {
        "kind": "and",
        "values": [
          {
            "kind": "in",
            "elem": {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "status"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            },
            "set": {
              "kind": "set",
              "values": [
                {
                  "kind": "lit",
                  "value": "SECURED"
                },
                {
                  "kind": "lit",
                  "value": "REVOKED"
                }
              ]
            }
          },
          {
            "kind": "not",
            "value": {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "legalHold"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            }
          }
        ]
      },
      "updates": [
        {
          "kind": "setMap",
          "name": "legalHold",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": true
          }
        }
      ]
    },
    "removeLegalHold": {
      "params": {
        "a": "Anchors"
      },
      "guard": {
        "kind": "and",
        "values": [
          {
            "kind": "in",
            "elem": {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "status"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            },
            "set": {
              "kind": "set",
              "values": [
                {
                  "kind": "lit",
                  "value": "SECURED"
                },
                {
                  "kind": "lit",
                  "value": "REVOKED"
                }
              ]
            }
          },
          {
            "kind": "index",
            "target": {
              "kind": "var",
              "name": "legalHold"
            },
            "key": {
              "kind": "param",
              "name": "a"
            }
          }
        ]
      },
      "updates": [
        {
          "kind": "setMap",
          "name": "legalHold",
          "key": {
            "kind": "param",
            "name": "a"
          },
          "value": {
            "kind": "lit",
            "value": false
          }
        }
      ]
    }
  },
  "invariants": {
    "securedRequiresChainTx": {
      "description": "A document cannot be SECURED without a valid chain_tx_id",
      "formula": {
        "kind": "forall",
        "domain": "Anchors",
        "binder": "a",
        "where": {
          "kind": "or",
          "values": [
            {
              "kind": "not",
              "value": {
                "kind": "eq",
                "left": {
                  "kind": "index",
                  "target": {
                    "kind": "var",
                    "name": "status"
                  },
                  "key": {
                    "kind": "param",
                    "name": "a"
                  }
                },
                "right": {
                  "kind": "lit",
                  "value": "SECURED"
                }
              }
            },
            {
              "kind": "eq",
              "left": {
                "kind": "index",
                "target": {
                  "kind": "var",
                  "name": "chainTxId"
                },
                "key": {
                  "kind": "param",
                  "name": "a"
                }
              },
              "right": {
                "kind": "lit",
                "value": "has_tx"
              }
            }
          ]
        }
      }
    },
    "fingerprintImmutableAfterPending": {
      "description": "Fingerprint is immutable once status leaves initial PENDING",
      "formula": {
        "kind": "forall",
        "domain": "Anchors",
        "binder": "a",
        "where": {
          "kind": "or",
          "values": [
            {
              "kind": "eq",
              "left": {
                "kind": "index",
                "target": {
                  "kind": "var",
                  "name": "status"
                },
                "key": {
                  "kind": "param",
                  "name": "a"
                }
              },
              "right": {
                "kind": "lit",
                "value": "PENDING"
              }
            },
            {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "fingerprintLocked"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            }
          ]
        }
      }
    },
    "revokedIsTerminal": {
      "description": "REVOKED is a terminal state with no outbound transitions",
      "formula": {
        "kind": "forall",
        "domain": "Anchors",
        "binder": "a",
        "where": {
          "kind": "or",
          "values": [
            {
              "kind": "not",
              "value": {
                "kind": "eq",
                "left": {
                  "kind": "index",
                  "target": {
                    "kind": "var",
                    "name": "status"
                  },
                  "key": {
                    "kind": "param",
                    "name": "a"
                  }
                },
                "right": {
                  "kind": "lit",
                  "value": "REVOKED"
                }
              }
            },
            {
              "kind": "eq",
              "left": {
                "kind": "index",
                "target": {
                  "kind": "var",
                  "name": "chainTxId"
                },
                "key": {
                  "kind": "param",
                  "name": "a"
                }
              },
              "right": {
                "kind": "lit",
                "value": "has_tx"
              }
            }
          ]
        }
      }
    },
    "metadataImmutableAfterSecured": {
      "description": "Metadata is immutable once anchor is SECURED or REVOKED",
      "formula": {
        "kind": "forall",
        "domain": "Anchors",
        "binder": "a",
        "where": {
          "kind": "or",
          "values": [
            {
              "kind": "not",
              "value": {
                "kind": "in",
                "elem": {
                  "kind": "index",
                  "target": {
                    "kind": "var",
                    "name": "status"
                  },
                  "key": {
                    "kind": "param",
                    "name": "a"
                  }
                },
                "set": {
                  "kind": "set",
                  "values": [
                    {
                      "kind": "lit",
                      "value": "SECURED"
                    },
                    {
                      "kind": "lit",
                      "value": "REVOKED"
                    }
                  ]
                }
              }
            },
            {
              "kind": "index",
              "target": {
                "kind": "var",
                "name": "metadataLocked"
              },
              "key": {
                "kind": "param",
                "name": "a"
              }
            }
          ]
        }
      }
    },
    "onlyWorkerSecures": {
      "description": "No direct client transition to SECURED — worker-only via service_role",
      "formula": {
        "kind": "forall",
        "domain": "Anchors",
        "binder": "a",
        "where": {
          "kind": "or",
          "values": [
            {
              "kind": "not",
              "value": {
                "kind": "eq",
                "left": {
                  "kind": "index",
                  "target": {
                    "kind": "var",
                    "name": "status"
                  },
                  "key": {
                    "kind": "param",
                    "name": "a"
                  }
                },
                "right": {
                  "kind": "lit",
                  "value": "SECURED"
                }
              }
            },
            {
              "kind": "eq",
              "left": {
                "kind": "index",
                "target": {
                  "kind": "var",
                  "name": "actor"
                },
                "key": {
                  "kind": "param",
                  "name": "a"
                }
              },
              "right": {
                "kind": "lit",
                "value": "worker"
              }
            }
          ]
        }
      }
    },
    "legalHoldPreventsSecuredToRevoked": {
      "description": "SECURED anchors under legal hold remain SECURED (guard blocks revoke)",
      "formula": {
        "kind": "forall",
        "domain": "Anchors",
        "binder": "a",
        "where": {
          "kind": "or",
          "values": [
            {
              "kind": "not",
              "value": {
                "kind": "index",
                "target": {
                  "kind": "var",
                  "name": "legalHold"
                },
                "key": {
                  "kind": "param",
                  "name": "a"
                }
              }
            },
            {
              "kind": "not",
              "value": {
                "kind": "eq",
                "left": {
                  "kind": "index",
                  "target": {
                    "kind": "var",
                    "name": "status"
                  },
                  "key": {
                    "kind": "param",
                    "name": "a"
                  }
                },
                "right": {
                  "kind": "lit",
                  "value": "PENDING"
                }
              }
            }
          ]
        }
      }
    }
  },
  "proof": {
    "defaultTier": "pr",
    "tiers": {
      "pr": {
        "domains": {
          "Anchors": {
            "kind": "ids",
            "prefix": "a",
            "size": 2
          }
        },
        "budgets": {
          "maxEstimatedStates": 100000,
          "maxEstimatedBranching": 10000
        }
      },
      "nightly": {
        "domains": {
          "Anchors": {
            "kind": "ids",
            "prefix": "a",
            "size": 3
          }
        },
        "budgets": {
          "maxEstimatedStates": 100000,
          "maxEstimatedBranching": 10000
        }
      }
    }
  },
  "metadata": {
    "ownedTables": [
      "anchors"
    ],
    "ownedColumns": {
      "anchors": [
        "status",
        "chainTxId",
        "fingerprintLocked",
        "metadataLocked",
        "legalHold",
        "actor"
      ]
    },
    "runtimeAdapter": {
      "schema": "public",
      "table": "anchors",
      "rowDomain": "Anchors",
      "keyColumn": "id",
      "keySqlType": "uuid"
    }
  }
} as const satisfies MachineDef;

const spec = {
  "schema": "public",
  "table": "anchors",
  "rowDomain": "Anchors",
  "keyColumn": "id",
  "keySqlType": "uuid",
  "variableColumns": [
    {
      "variableName": "status",
      "columnName": "status"
    },
    {
      "variableName": "chainTxId",
      "columnName": "chainTxId"
    },
    {
      "variableName": "fingerprintLocked",
      "columnName": "fingerprintLocked"
    },
    {
      "variableName": "metadataLocked",
      "columnName": "metadataLocked"
    },
    {
      "variableName": "legalHold",
      "columnName": "legalHold"
    },
    {
      "variableName": "actor",
      "columnName": "actor"
    }
  ],
  "actionRowLiteralKeys": {
    "workerPickUp": [],
    "chainSubmitSuccess": [],
    "chainSubmitFail": [],
    "revoke": [],
    "placeLegalHold": [],
    "removeLegalHold": []
  }
} as const satisfies GeneratedAdapterSpec;

export interface WorkerPickUpEnv {
  a: string;
}

export interface ChainSubmitSuccessEnv {
  a: string;
}

export interface ChainSubmitFailEnv {
  a: string;
}

export interface RevokeEnv {
  a: string;
}

export interface PlaceLegalHoldEnv {
  a: string;
}

export interface RemoveLegalHoldEnv {
  a: string;
}

export const workerPickUp = async (
  sql: AdapterSqlClient,
  env: WorkerPickUpEnv
): Promise<AdapterWriteResult> =>
  applyGeneratedAction(sql, machine, spec, "workerPickUp", {
    a: String(env.a)
  });

export const chainSubmitSuccess = async (
  sql: AdapterSqlClient,
  env: ChainSubmitSuccessEnv
): Promise<AdapterWriteResult> =>
  applyGeneratedAction(sql, machine, spec, "chainSubmitSuccess", {
    a: String(env.a)
  });

export const chainSubmitFail = async (
  sql: AdapterSqlClient,
  env: ChainSubmitFailEnv
): Promise<AdapterWriteResult> =>
  applyGeneratedAction(sql, machine, spec, "chainSubmitFail", {
    a: String(env.a)
  });

export const revoke = async (
  sql: AdapterSqlClient,
  env: RevokeEnv
): Promise<AdapterWriteResult> =>
  applyGeneratedAction(sql, machine, spec, "revoke", {
    a: String(env.a)
  });

export const placeLegalHold = async (
  sql: AdapterSqlClient,
  env: PlaceLegalHoldEnv
): Promise<AdapterWriteResult> =>
  applyGeneratedAction(sql, machine, spec, "placeLegalHold", {
    a: String(env.a)
  });

export const removeLegalHold = async (
  sql: AdapterSqlClient,
  env: RemoveLegalHoldEnv
): Promise<AdapterWriteResult> =>
  applyGeneratedAction(sql, machine, spec, "removeLegalHold", {
    a: String(env.a)
  });

export default {
  workerPickUp,
  chainSubmitSuccess,
  chainSubmitFail,
  revoke,
  placeLegalHold,
  removeLegalHold,
};