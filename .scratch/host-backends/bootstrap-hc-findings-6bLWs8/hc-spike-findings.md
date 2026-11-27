# Live hc spike findings

## a. Send wrapping and reach

```json
{}
```

## b. OSC 7501 status reports

```json
{
  "capabilityQueries": {
    "query BEL": {
      "wire": {
        "hex": "1b5d373530313b3f07",
        "utf8": "\u001b]7501;?\u0007"
      },
      "reply": {
        "hex": "1b5d373530313b3f3a7374617465733d69646c652c776f726b696e672c646f6e652c626c6f636b65642c6572726f723a6b696e64733d7065726d697373696f6e2c7175657374696f6e2c6175746807",
        "utf8": "\u001b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\u0007"
      }
    },
    "query ST": {
      "wire": {
        "hex": "1b5d373530313b3f1b5c",
        "utf8": "\u001b]7501;?\u001b\\"
      },
      "reply": {
        "hex": "1b5d373530313b3f3a7374617465733d69646c652c776f726b696e672c646f6e652c626c6f636b65642c6572726f723a6b696e64733d7065726d697373696f6e2c7175657374696f6e2c617574681b5c",
        "utf8": "\u001b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\u001b\\"
      }
    },
    "query-with-caps BEL": {
      "wire": {
        "hex": "1b5d373530313b3f3a7374617465733d69646c652c776f726b696e672c646f6e652c626c6f636b65642c6572726f723a6b696e64733d7065726d697373696f6e2c7175657374696f6e2c6175746807",
        "utf8": "\u001b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\u0007"
      },
      "reply": {
        "hex": "",
        "utf8": ""
      }
    },
    "query-with-caps ST": {
      "wire": {
        "hex": "1b5d373530313b3f3a7374617465733d69646c652c776f726b696e672c646f6e652c626c6f636b65642c6572726f723a6b696e64733d7065726d697373696f6e2c7175657374696f6e2c617574681b5c",
        "utf8": "\u001b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\u001b\\"
      },
      "reply": {
        "hex": "",
        "utf8": ""
      }
    }
  },
  "minimalStates": {
    "idle ST": {
      "address": "t2",
      "terminalName": "osc-min-idle-st",
      "wire": {
        "hex": "1b5d373530313b73746174653d69646c651b5c",
        "utf8": "\u001b]7501;state=idle\u001b\\"
      },
      "before": {
        "address": "t2",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-idle-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310141,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
            "osc-min-idle-st",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-YzQyvC",
          "name": "node-MainThread",
          "pid": 521243
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-idle-st",
        "notify": false,
        "parent": null,
        "pid": 521243,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t2",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-idle-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310141,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
            "osc-min-idle-st",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-YzQyvC",
          "name": "node-MainThread",
          "pid": 521243
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-idle-st",
        "notify": false,
        "parent": null,
        "pid": 521243,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "idle"
        },
        "status_ms": 1795733310228,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t2\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-min-idle-st\",\"state\":\"live\",\"status\":\"idle\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t2",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-min-idle-st",
        "state": "live",
        "status": "idle",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "idle"
        },
        "status_ms": 1795733310228,
        "turn": 0,
        "records": null,
        "lsStatus": "idle"
      },
      "observedFields": {
        "state": "idle",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "working ST": {
      "address": "t3",
      "terminalName": "osc-min-working-st",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e671b5c",
        "utf8": "\u001b]7501;state=working\u001b\\"
      },
      "before": {
        "address": "t3",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-working-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310288,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-working-st",
        "notify": false,
        "parent": null,
        "pid": 521277,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t3",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-working-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310288,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-working-st",
        "notify": false,
        "parent": null,
        "pid": 521277,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "working"
        },
        "status_ms": 1795733310393,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t3\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-min-working-st\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t3",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-min-working-st",
        "state": "live",
        "status": "working",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 4,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "working"
        },
        "status_ms": 1795733310393,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "done ST": {
      "address": "t4",
      "terminalName": "osc-min-done-st",
      "wire": {
        "hex": "1b5d373530313b73746174653d646f6e651b5c",
        "utf8": "\u001b]7501;state=done\u001b\\"
      },
      "before": {
        "address": "t4",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-done-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310434,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-done-st",
        "notify": false,
        "parent": null,
        "pid": 521311,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t4",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-done-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310434,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-done-st",
        "notify": false,
        "parent": null,
        "pid": 521311,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "done"
        },
        "status_ms": 1795733310521,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t4\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-min-done-st\",\"state\":\"live\",\"status\":\"done\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t4",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-min-done-st",
        "state": "live",
        "status": "done",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "done"
        },
        "status_ms": 1795733310521,
        "turn": 0,
        "records": null,
        "lsStatus": "done"
      },
      "observedFields": {
        "state": "done",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "blocked ST": {
      "address": "t5",
      "terminalName": "osc-min-blocked-st",
      "wire": {
        "hex": "1b5d373530313b73746174653d626c6f636b65641b5c",
        "utf8": "\u001b]7501;state=blocked\u001b\\"
      },
      "before": {
        "address": "t5",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-blocked-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310578,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-blocked-st",
        "notify": false,
        "parent": null,
        "pid": 521345,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t5",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-blocked-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310578,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-blocked-st",
        "notify": false,
        "parent": null,
        "pid": 521345,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "blocked"
        },
        "status_ms": 1795733310683,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t5\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-min-blocked-st\",\"state\":\"live\",\"status\":\"blocked\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t5",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-min-blocked-st",
        "state": "live",
        "status": "blocked",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "blocked"
        },
        "status_ms": 1795733310683,
        "turn": 0,
        "records": null,
        "lsStatus": "blocked"
      },
      "observedFields": {
        "state": "blocked",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "error ST": {
      "address": "t6",
      "terminalName": "osc-min-error-st",
      "wire": {
        "hex": "1b5d373530313b73746174653d6572726f721b5c",
        "utf8": "\u001b]7501;state=error\u001b\\"
      },
      "before": {
        "address": "t6",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-error-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310723,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-error-st",
        "notify": false,
        "parent": null,
        "pid": 521379,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t6",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-error-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310723,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-error-st",
        "notify": false,
        "parent": null,
        "pid": 521379,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "error"
        },
        "status_ms": 1795733310825,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t6\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-min-error-st\",\"state\":\"live\",\"status\":\"error\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t6",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-min-error-st",
        "state": "live",
        "status": "error",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "error"
        },
        "status_ms": 1795733310825,
        "turn": 0,
        "records": null,
        "lsStatus": "error"
      },
      "observedFields": {
        "state": "error",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "working BEL": {
      "address": "t7",
      "terminalName": "osc-min-working-bel",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e6707",
        "utf8": "\u001b]7501;state=working\u0007"
      },
      "before": {
        "address": "t7",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-working-bel",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310867,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-working-bel",
        "notify": false,
        "parent": null,
        "pid": 521413,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t7",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-working-bel",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733310867,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-working-bel",
        "notify": false,
        "parent": null,
        "pid": 521413,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "working"
        },
        "status_ms": 1795733310957,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t7\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-min-working-bel\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t7",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-min-working-bel",
        "state": "live",
        "status": "working",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "working"
        },
        "status_ms": 1795733310957,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "blocked BEL": {
      "address": "t8",
      "terminalName": "osc-min-blocked-bel",
      "wire": {
        "hex": "1b5d373530313b73746174653d626c6f636b656407",
        "utf8": "\u001b]7501;state=blocked\u0007"
      },
      "before": {
        "address": "t8",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-blocked-bel",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733311011,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-blocked-bel",
        "notify": false,
        "parent": null,
        "pid": 521447,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t8",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-blocked-bel",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733311011,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-blocked-bel",
        "notify": false,
        "parent": null,
        "pid": 521447,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "blocked"
        },
        "status_ms": 1795733311115,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t8\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-min-blocked-bel\",\"state\":\"live\",\"status\":\"blocked\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t8",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-min-blocked-bel",
        "state": "live",
        "status": "blocked",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "blocked"
        },
        "status_ms": 1795733311115,
        "turn": 0,
        "records": null,
        "lsStatus": "blocked"
      },
      "observedFields": {
        "state": "blocked",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    }
  },
  "acceptedTerminator": "\u001b\\",
  "singleKeys": {
    "app": {
      "address": "t9",
      "terminalName": "osc-key-app",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a6170703d7370696b651b5c",
        "utf8": "\u001b]7501;state=working:app=spike\u001b\\"
      },
      "before": {
        "address": "t9",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-app",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733311155,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
            "osc-key-app",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-YzQyvC",
          "name": "node-MainThread",
          "pid": 521481
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-app",
        "notify": false,
        "parent": null,
        "pid": 521481,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t9",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-app",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733311155,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
            "osc-key-app",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-YzQyvC",
          "name": "node-MainThread",
          "pid": 521481
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-app",
        "notify": false,
        "parent": null,
        "pid": 521481,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "app": "spike",
          "state": "working"
        },
        "status_ms": 1795733311242,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t9\",\"agent\":\"spike\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-key-app\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t9",
        "agent": "spike",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-key-app",
        "state": "live",
        "status": "working",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "app": "spike",
          "state": "working"
        },
        "status_ms": 1795733311242,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": "spike",
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "msg": {
      "address": "t10",
      "terminalName": "osc-key-msg",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a6d73673d68656c6c6f1b5c",
        "utf8": "\u001b]7501;state=working:msg=hello\u001b\\"
      },
      "before": {
        "address": "t10",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-msg",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733311299,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-msg",
        "notify": false,
        "parent": null,
        "pid": 521515,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t10",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-msg",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733311299,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
            "osc-key-msg",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-YzQyvC",
          "name": "node-MainThread",
          "pid": 521515
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-msg",
        "notify": false,
        "parent": null,
        "pid": 521515,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t10\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-key-msg\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t10",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-key-msg",
        "state": "live",
        "turn": 0
      },
      "polls": 13,
      "elapsedMs": 503,
      "statusChanged": false,
      "accepted": false,
      "acceptedAny": false,
      "representation": {
        "reported": false,
        "status": null,
        "status_ms": null,
        "turn": 0,
        "records": null,
        "lsStatus": null
      },
      "observedFields": {
        "state": null,
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "message": {
      "address": "t11",
      "terminalName": "osc-key-message",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a6d6573736167653d68656c6c6f1b5c",
        "utf8": "\u001b]7501;state=working:message=hello\u001b\\"
      },
      "before": {
        "address": "t11",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-message",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733311943,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-message",
        "notify": false,
        "parent": null,
        "pid": 521599,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t11",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-message",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733311943,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-message",
        "notify": false,
        "parent": null,
        "pid": 521599,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "working"
        },
        "status_ms": 1795733312033,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t11\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-key-message\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t11",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-key-message",
        "state": "live",
        "status": "working",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "working"
        },
        "status_ms": 1795733312033,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "title": {
      "address": "t12",
      "terminalName": "osc-key-title",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a7469746c653d5370696b651b5c",
        "utf8": "\u001b]7501;state=working:title=Spike\u001b\\"
      },
      "before": {
        "address": "t12",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-title",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733312085,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-title",
        "notify": false,
        "parent": null,
        "pid": 521633,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t12",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-title",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733312085,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
            "osc-key-title",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-YzQyvC",
          "name": "node-MainThread",
          "pid": 521633
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-title",
        "notify": false,
        "parent": null,
        "pid": 521633,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t12\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-key-title\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t12",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-key-title",
        "state": "live",
        "turn": 0
      },
      "polls": 13,
      "elapsedMs": 503,
      "statusChanged": false,
      "accepted": false,
      "acceptedAny": false,
      "representation": {
        "reported": false,
        "status": null,
        "status_ms": null,
        "turn": 0,
        "records": null,
        "lsStatus": null
      },
      "observedFields": {
        "state": null,
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "progress": {
      "address": "t13",
      "terminalName": "osc-key-progress",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a70726f67726573733d33371b5c",
        "utf8": "\u001b]7501;state=working:progress=37\u001b\\"
      },
      "before": {
        "address": "t13",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-progress",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733312728,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-progress",
        "notify": false,
        "parent": null,
        "pid": 521716,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t13",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-progress",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733312728,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-progress",
        "notify": false,
        "parent": null,
        "pid": 521716,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "progress": 37,
          "state": "working"
        },
        "status_ms": 1795733312832,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t13\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-key-progress\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t13",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-key-progress",
        "state": "live",
        "status": "working",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "progress": 37,
          "state": "working"
        },
        "status_ms": 1795733312832,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": 37,
        "kind": null,
        "records": null
      }
    },
    "kind": {
      "address": "t14",
      "terminalName": "osc-key-kind",
      "wire": {
        "hex": "1b5d373530313b73746174653d626c6f636b65643a6b696e643d7065726d697373696f6e1b5c",
        "utf8": "\u001b]7501;state=blocked:kind=permission\u001b\\"
      },
      "before": {
        "address": "t14",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-kind",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733312871,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-kind",
        "notify": false,
        "parent": null,
        "pid": 521750,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t14",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-kind",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733312871,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-kind",
        "notify": false,
        "parent": null,
        "pid": 521750,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "kind": "permission",
          "state": "blocked"
        },
        "status_ms": 1795733312956,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t14\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-key-kind\",\"state\":\"live\",\"status\":\"blocked\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t14",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-key-kind",
        "state": "live",
        "status": "blocked",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "kind": "permission",
          "state": "blocked"
        },
        "status_ms": 1795733312956,
        "turn": 0,
        "records": null,
        "lsStatus": "blocked"
      },
      "observedFields": {
        "state": "blocked",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": "permission",
        "records": null
      }
    },
    "id": {
      "address": "t15",
      "terminalName": "osc-key-id",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a69643d776f726b6572311b5c",
        "utf8": "\u001b]7501;state=working:id=worker1\u001b\\"
      },
      "before": {
        "address": "t15",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-id",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313014,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-id",
        "notify": false,
        "parent": null,
        "pid": 521793,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t15",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-id",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313014,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-id",
        "notify": false,
        "parent": null,
        "pid": 521793,
        "reason": null,
        "records": {
          "worker1": {
            "state": "working"
          }
        },
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t15\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-key-id\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t15",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-key-id",
        "state": "live",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": false,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": null,
        "status_ms": null,
        "turn": 0,
        "records": {
          "worker1": {
            "state": "working"
          }
        },
        "lsStatus": null
      },
      "observedFields": {
        "state": null,
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": {
          "worker1": {
            "state": "working"
          }
        }
      }
    }
  },
  "modCombo": {
    "address": "t16",
    "terminalName": "osc-mod-hermes",
    "wire": {
      "hex": "1b5d373530313b73746174653d776f726b696e673a6170703d6865726d65731b5c",
      "utf8": "\u001b]7501;state=working:app=hermes\u001b\\"
    },
    "before": {
      "address": "t16",
      "argv": [
        "/usr/bin/node",
        "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
        "osc-mod-hermes",
        "read"
      ],
      "cols": 200,
      "created_ms": 1795733313157,
      "cwd": "/tmp/bootstrap-hc-YzQyvC",
      "die_with_parent": false,
      "exit_code": null,
      "finished_ms": null,
      "foreground": {
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-mod-hermes",
          "read"
        ],
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "node-MainThread",
        "pid": 521828
      },
      "identity": "ghostty",
      "keep": false,
      "labels": {},
      "name": "osc-mod-hermes",
      "notify": false,
      "parent": null,
      "pid": 521828,
      "reason": null,
      "reported": false,
      "rm": false,
      "rows": 120,
      "screen": "exact",
      "signal": null,
      "state": "live",
      "status": null,
      "status_ms": null,
      "template": null,
      "title": "",
      "turn": 0
    },
    "after": {
      "address": "t16",
      "argv": [
        "/usr/bin/node",
        "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
        "osc-mod-hermes",
        "read"
      ],
      "cols": 200,
      "created_ms": 1795733313157,
      "cwd": "/tmp/bootstrap-hc-YzQyvC",
      "die_with_parent": false,
      "exit_code": null,
      "finished_ms": null,
      "foreground": {
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-mod-hermes",
          "read"
        ],
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "node-MainThread",
        "pid": 521828
      },
      "identity": "ghostty",
      "keep": false,
      "labels": {},
      "name": "osc-mod-hermes",
      "notify": false,
      "parent": null,
      "pid": 521828,
      "reason": null,
      "reported": true,
      "rm": false,
      "rows": 120,
      "screen": "exact",
      "signal": null,
      "state": "live",
      "status": {
        "app": "hermes",
        "state": "working"
      },
      "status_ms": 1795733313242,
      "template": null,
      "title": "",
      "turn": 0
    },
    "ls": {
      "code": 0,
      "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t16\",\"agent\":\"hermes\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-mod-hermes\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
      "stderr": "",
      "timedOut": false
    },
    "lsTerminal": {
      "address": "t16",
      "agent": "hermes",
      "cwd": "/tmp/bootstrap-hc-YzQyvC",
      "name": "osc-mod-hermes",
      "state": "live",
      "status": "working",
      "turn": 0
    },
    "polls": 1,
    "elapsedMs": 3,
    "statusChanged": true,
    "accepted": true,
    "acceptedAny": true,
    "representation": {
      "reported": true,
      "status": {
        "app": "hermes",
        "state": "working"
      },
      "status_ms": 1795733313242,
      "turn": 0,
      "records": null,
      "lsStatus": "working"
    },
    "observedFields": {
      "state": "working",
      "app": "hermes",
      "msg": null,
      "message": null,
      "title": null,
      "progress": null,
      "kind": null,
      "records": null
    }
  },
  "escapingMsgKey": "message",
  "escaping": {
    "spaces": {
      "address": "t17",
      "terminalName": "osc-esc-spaces",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a6d6573736167653d706c61696e206d6573736167651b5c",
        "utf8": "\u001b]7501;state=working:message=plain message\u001b\\"
      },
      "before": {
        "address": "t17",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-spaces",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313301,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-spaces",
        "notify": false,
        "parent": null,
        "pid": 521862,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t17",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-spaces",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313301,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-spaces",
        "notify": false,
        "parent": null,
        "pid": 521862,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "working"
        },
        "status_ms": 1795733313404,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t17\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-esc-spaces\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t17",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-esc-spaces",
        "state": "live",
        "status": "working",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "working"
        },
        "status_ms": 1795733313404,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      },
      "msgKey": "message",
      "observedMsg": null
    },
    "colon": {
      "address": "t18",
      "terminalName": "osc-esc-colon",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a6d6573736167653d737465703a2064657461696c1b5c",
        "utf8": "\u001b]7501;state=working:message=step: detail\u001b\\"
      },
      "before": {
        "address": "t18",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-colon",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313446,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-colon",
        "notify": false,
        "parent": null,
        "pid": 521896,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t18",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-colon",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313446,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-colon",
        "notify": false,
        "parent": null,
        "pid": 521896,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "working"
        },
        "status_ms": 1795733313550,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t18\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-esc-colon\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t18",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-esc-colon",
        "state": "live",
        "status": "working",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 4,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "working"
        },
        "status_ms": 1795733313550,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      },
      "msgKey": "message",
      "observedMsg": null
    },
    "unicode": {
      "address": "t19",
      "terminalName": "osc-esc-unicode",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a6d6573736167653d636166c3a920e29c9320e2809420746573741b5c",
        "utf8": "\u001b]7501;state=working:message=café ✓ — test\u001b\\"
      },
      "before": {
        "address": "t19",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-unicode",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313589,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-unicode",
        "notify": false,
        "parent": null,
        "pid": 521930,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t19",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-unicode",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313589,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-unicode",
        "notify": false,
        "parent": null,
        "pid": 521930,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "working"
        },
        "status_ms": 1795733313689,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t19\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-esc-unicode\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t19",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-esc-unicode",
        "state": "live",
        "status": "working",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "working"
        },
        "status_ms": 1795733313689,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      },
      "msgKey": "message",
      "observedMsg": null
    },
    "percent-encoding": {
      "address": "t1b",
      "terminalName": "osc-esc-percent",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a6d6573736167653d73656d69253342253230636f6c6f6e253341253230657175616c7325334425323070657263656e7425323525323071756f7465253232253230736c6173682535432532306361662543332541391b5c",
        "utf8": "\u001b]7501;state=working:message=semi%3B%20colon%3A%20equals%3D%20percent%25%20quote%22%20slash%5C%20caf%C3%A9\u001b\\"
      },
      "before": {
        "address": "t1b",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-percent",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313731,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-percent",
        "notify": false,
        "parent": null,
        "pid": 521964,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t1b",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-percent",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313731,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-percent",
        "notify": false,
        "parent": null,
        "pid": 521964,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "state": "working"
        },
        "status_ms": 1795733313834,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1b\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-esc-percent\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1b",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-esc-percent",
        "state": "live",
        "status": "working",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "working"
        },
        "status_ms": 1795733313834,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      },
      "msgKey": "message",
      "observedMsg": null
    }
  },
  "recordsById": {
    "state-first-id": {
      "address": "t1c",
      "terminalName": "osc-rec-state-first",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a69643d776f726b6572311b5c",
        "utf8": "\u001b]7501;state=working:id=worker1\u001b\\"
      },
      "before": {
        "address": "t1c",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-rec-state-first",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313874,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-rec-state-first",
        "notify": false,
        "parent": null,
        "pid": 522003,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t1c",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-rec-state-first",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733313874,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-rec-state-first",
        "notify": false,
        "parent": null,
        "pid": 522003,
        "reason": null,
        "records": {
          "worker1": {
            "state": "working"
          }
        },
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1c\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-rec-state-first\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1c",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-rec-state-first",
        "state": "live",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": false,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": null,
        "status_ms": null,
        "turn": 0,
        "records": {
          "worker1": {
            "state": "working"
          }
        },
        "lsStatus": null
      },
      "observedFields": {
        "state": null,
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": {
          "worker1": {
            "state": "working"
          }
        }
      }
    },
    "id-first-state": {
      "address": "t1d",
      "terminalName": "osc-rec-id-first",
      "wire": {
        "hex": "1b5d373530313b69643d776f726b6572313a73746174653d776f726b696e671b5c",
        "utf8": "\u001b]7501;id=worker1:state=working\u001b\\"
      },
      "before": {
        "address": "t1d",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-rec-id-first",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733314017,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-rec-id-first",
        "notify": false,
        "parent": null,
        "pid": 522037,
        "reason": null,
        "reported": false,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t1d",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/integration/bootstrap/test-support/hc-live-terminal.ts",
          "osc-rec-id-first",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795733314017,
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-rec-id-first",
        "notify": false,
        "parent": null,
        "pid": 522037,
        "reason": null,
        "records": {
          "worker1": {
            "state": "working"
          }
        },
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": null,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1d\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-YzQyvC\",\"name\":\"osc-rec-id-first\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1d",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-YzQyvC",
        "name": "osc-rec-id-first",
        "state": "live",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": false,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": null,
        "status_ms": null,
        "turn": 0,
        "records": {
          "worker1": {
            "state": "working"
          }
        },
        "lsStatus": null
      },
      "observedFields": {
        "state": null,
        "app": null,
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": {
          "worker1": {
            "state": "working"
          }
        }
      }
    }
  },
  "coreLog": {
    "files": [
      "/tmp/bootstrap-hc-YzQyvC/state/herdr-core/bootstrap-hc-YzQyvC/core.log"
    ],
    "tail": [],
    "osc7501Lines": []
  },
  "observations": {
    "capabilityQueryBel": {
      "observed": true
    },
    "capabilityQuerySt": {
      "observed": true
    },
    "minimalStates": {
      "observed": true,
      "observedWords": [
        "idle",
        "working",
        "done",
        "blocked",
        "error"
      ],
      "missing": []
    },
    "recordsById": {
      "observed": true
    }
  }
}
```

## c. Core isolation and teardown

```json
{
  "root": "/tmp/bootstrap-hc-YzQyvC",
  "env": {
    "LANG": "en_US.UTF-8",
    "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
    "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
    "HC_SESSION": "bootstrap-hc-YzQyvC",
    "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
    "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
    "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
    "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
    "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state",
    "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
    "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
    "SHELL": "/bin/sh",
    "TERM": "xterm-256color"
  },
  "shimDir": "/tmp/bootstrap-hc-YzQyvC/bin",
  "shimLogPath": "/tmp/bootstrap-hc-YzQyvC/shim-calls.log",
  "stopCommand": "env -i HC_SESSION='bootstrap-hc-YzQyvC' HC_SOCKET='/tmp/bootstrap-hc-YzQyvC/runtime/core.sock' HOME='/tmp/bootstrap-hc-YzQyvC/home' LANG='en_US.UTF-8' PATH='/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin' SHELL='/bin/sh' TERM='xterm-256color' TMPDIR='/tmp/bootstrap-hc-YzQyvC/tmp' XDG_CACHE_HOME='/tmp/bootstrap-hc-YzQyvC/cache' XDG_CONFIG_HOME='/tmp/bootstrap-hc-YzQyvC/config' XDG_DATA_HOME='/tmp/bootstrap-hc-YzQyvC/data' XDG_RUNTIME_DIR='/tmp/bootstrap-hc-YzQyvC/runtime' XDG_STATE_HOME='/tmp/bootstrap-hc-YzQyvC/state' hc server stop --json",
  "selectedQuestions": [
    "b",
    "h"
  ],
  "start": [
    "server",
    "start",
    "--json"
  ],
  "stop": [
    "server",
    "stop",
    "--json"
  ],
  "ownership": "Fresh Unix socket, inode, core id, systemd shims, /proc/<pid>/environ (allowing HC_RUNTIME=1) + /proc/<pid>/cgroup checks",
  "terminalEnvs": {
    "osc-cap-query": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970726-186e89f20898623af034ec5e41c43120",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t1",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-min-idle-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970816-9310f02572c4cf99caae2b6ef2eb0047",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t2",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-min-working-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970831-4a53fe40d20ecb888834d2d3385c993c",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t3",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-min-done-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970845-a75bc4d7fe2763b1fd9492833e0865cc",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t4",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-min-blocked-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970860-9a18e372e2658b644ad738f8054edb45",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t5",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-min-error-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970874-c03e109038cade9d26403bb143fc621c",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t6",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-min-working-bel": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970889-9808226de5993c8a9f73f19800f0acf3",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t7",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-min-blocked-bel": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970903-c6e1727d827c7fe7caea1fabf5b9ea13",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t8",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-key-app": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970917-b9cb86af94a1a482ae994275907e49e6",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t9",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-key-msg": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970932-e0aaaa7ba95b47b1f1ccaa8d5d61517f",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t10",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-key-message": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4970996-9082f99bf9189c7c377ebf5afb99804f",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t11",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-key-title": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971010-b9e8e67c5331501fe51334c6257bcee5",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t12",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-key-progress": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971075-c2eb60062d4ec6195313a80d3c07573e",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t13",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-key-kind": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971089-cdaa13d0b3700e8e017202b752b85b01",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t14",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-key-id": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971103-390d183c9052c7a8eca16edf0c430ffd",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t15",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-mod-hermes": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971118-738e3bb6bf96484c56828f1a7793e7e4",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t16",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-esc-spaces": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971132-043112a8139002ea7bb5f5e90470487c",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t17",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-esc-colon": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971146-c67c21c3dab4fdd7fcf8020de6fd746a",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t18",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-esc-unicode": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971161-e8b72f76bf6bad0f2c7374c86338d490",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t19",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-esc-percent": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971175-f622c4f6be983b33e2af52e7f7a75802",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t1b",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-rec-state-first": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971189-dfcfaa8f5ce4dd95e6a26ab06191b43f",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t1c",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "osc-rec-id-first": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971204-33f03e4ad5d4866e563ab774dea99534",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t1d",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "send-blocked": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971218-3f447114eeef39560a87916db79e0697",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t1f",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "send-working": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971817-4dc790f630260cd7ee13fd0ad8e3bfba",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t1g",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    },
    "send-done": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "4971934-f0acba712332d1229cce1e0d66188332",
      "HC_SESSION": "bootstrap-hc-YzQyvC",
      "HC_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HC_TERMINAL_ID": "t1h",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-YzQyvC/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-YzQyvC/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-YzQyvC/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-YzQyvC/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-YzQyvC/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-YzQyvC/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-YzQyvC/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-YzQyvC/state"
    }
  },
  "startResult": {
    "code": 0,
    "stdout": "{\"core\":{\"id\":\"4ba60686840ca0da113300cd45f28d8e\",\"name\":\"cachyos-x8664\"},\"finished\":0,\"holder\":null,\"holders\":[],\"installed_by\":null,\"keeps_running_after_logout\":null,\"live\":0,\"logout_linger_user\":null,\"pid\":521194,\"uptime_ms\":9,\"version\":\"0.1.22\"}\n",
    "stderr": "",
    "timedOut": false
  },
  "startPid": 521194,
  "identity": {
    "socket": "/tmp/bootstrap-hc-YzQyvC/runtime/core.sock",
    "device": 57,
    "inode": 4865143,
    "id": "4ba60686840ca0da113300cd45f28d8e",
    "pid": 521194
  },
  "cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-ghostty-surface-transient-8460.scope",
  "hasRuntimeMarker": true,
  "observedCoreRuntimeEnv": "1",
  "cleanup": [
    {
      "stopResult": {
        "mode": "verified",
        "stop": {
          "code": 0,
          "stdout": "{\"stopped\":true}\n",
          "stderr": "",
          "timedOut": false
        },
        "corePid": 521194,
        "holderPids": [
          521208
        ],
        "remainingCoreAlive": false,
        "remainingHolderPids": [],
        "socketRemaining": false,
        "stopped": true
      }
    }
  ],
  "corePid": 521194,
  "holderPids": [
    521208
  ],
  "teardownPids": {
    "mode": "verified",
    "corePid": 521194,
    "holderPids": [
      521208
    ],
    "remainingCoreAlive": false,
    "remainingHolderPids": [],
    "socketRemaining": false
  },
  "coreLog": {
    "files": [
      "/tmp/bootstrap-hc-YzQyvC/state/herdr-core/bootstrap-hc-YzQyvC/core.log"
    ],
    "tail": [],
    "osc7501Lines": []
  },
  "shimCalls": [],
  "shimCallCount": 0
}
```

## d. Send before stdin is read

```json
{}
```

## e. Label filtering, inspection, and RunResult

```json
{}
```

## f. Name reuse

```json
{}
```

## g. Server status shape

```json
{
  "startTopLevelKeys": [
    "core",
    "finished",
    "holder",
    "holders",
    "installed_by",
    "keeps_running_after_logout",
    "live",
    "logout_linger_user",
    "pid",
    "uptime_ms",
    "version"
  ],
  "raw": {
    "code": 0,
    "stdout": "{\"core\":{\"id\":\"4ba60686840ca0da113300cd45f28d8e\",\"name\":\"cachyos-x8664\"},\"finished\":0,\"holder\":null,\"holders\":[],\"installed_by\":null,\"keeps_running_after_logout\":null,\"live\":0,\"logout_linger_user\":null,\"pid\":521194,\"uptime_ms\":11,\"version\":\"0.1.22\"}\n",
    "stderr": "",
    "timedOut": false
  },
  "topLevelKeys": [
    "core",
    "finished",
    "holder",
    "holders",
    "installed_by",
    "keeps_running_after_logout",
    "live",
    "logout_linger_user",
    "pid",
    "uptime_ms",
    "version"
  ],
  "coreKeys": [
    "id",
    "name"
  ],
  "expectedTopLevelKeys": [
    "core",
    "version",
    "pid",
    "uptime_ms",
    "live",
    "finished",
    "holder",
    "holders",
    "installed_by",
    "keeps_running_after_logout",
    "logout_linger_user"
  ],
  "expectedCoreKeys": [
    "id",
    "name"
  ],
  "expectedKeysPresent": true,
  "ticket03ProbeMatches": true
}
```

## h. Blocked send

```json
{
  "blocked": {
    "address": "t1f",
    "wire": {
      "hex": "1b5d373530313b73746174653d626c6f636b65641b5c",
      "utf8": "\u001b]7501;state=blocked\u001b\\"
    },
    "statusObserved": true,
    "sendAttempted": true,
    "statusBefore": null,
    "statusAfter": {
      "state": "blocked"
    },
    "args": [
      "send",
      "--json",
      "t1f",
      "[BOOTSTRAP_WAKE handoff=blocked]"
    ],
    "sendDurationMs": 820,
    "waited": false,
    "result": {
      "code": 9,
      "stdout": "",
      "stderr": "{\"error\":{\"hint\":\"typing would answer its dialog; read its screen first (hc read t1f), or --force\",\"kind\":\"blocked\",\"message\":\"t1f is blocked (waiting)\"}}\n",
      "timedOut": false
    },
    "errorKind": "blocked",
    "input": {
      "hex": "",
      "utf8": ""
    },
    "delivered": false,
    "matchesContract": true
  },
  "working": {
    "address": "t1g",
    "wire": {
      "hex": "1b5d373530313b73746174653d776f726b696e671b5c",
      "utf8": "\u001b]7501;state=working\u001b\\"
    },
    "statusObserved": true,
    "sendAttempted": true,
    "statusBefore": null,
    "statusAfter": {
      "state": "working"
    },
    "args": [
      "send",
      "--json",
      "t1g",
      "[BOOTSTRAP_WAKE handoff=working]"
    ],
    "sendDurationMs": 1022,
    "waited": true,
    "result": {
      "code": 0,
      "stdout": "{\"started\":true,\"status\":\"working\",\"turn\":0}\n",
      "stderr": "",
      "timedOut": false
    },
    "errorKind": null,
    "input": {
      "hex": "5b424f4f5453545241505f57414b452068616e646f66663d776f726b696e675d0d",
      "utf8": "[BOOTSTRAP_WAKE handoff=working]\r"
    },
    "delivered": true
  },
  "done": {
    "address": "t1h",
    "wire": {
      "hex": "1b5d373530313b73746174653d646f6e651b5c",
      "utf8": "\u001b]7501;state=done\u001b\\"
    },
    "statusObserved": true,
    "sendAttempted": true,
    "statusBefore": null,
    "statusAfter": {
      "state": "done"
    },
    "args": [
      "send",
      "--json",
      "t1h",
      "[BOOTSTRAP_WAKE handoff=done]"
    ],
    "sendDurationMs": 6022,
    "waited": true,
    "result": {
      "code": 0,
      "stdout": "{\"started\":false,\"status\":\"done\",\"turn\":0}\n",
      "stderr": "",
      "timedOut": false
    },
    "errorKind": null,
    "input": {
      "hex": "5b424f4f5453545241505f57414b452068616e646f66663d646f6e655d0d",
      "utf8": "[BOOTSTRAP_WAKE handoff=done]\r"
    },
    "delivered": true
  },
  "observations": {
    "blockedRefused": {
      "observed": true,
      "statusObserved": true,
      "code": 9,
      "errorKind": "blocked",
      "deliveredBytes": 0
    },
    "workingSend": {
      "observed": true,
      "code": 0,
      "delivered": true,
      "waited": true
    },
    "doneSend": {
      "observed": true,
      "code": 0,
      "delivered": true,
      "waited": true
    }
  }
}
```

## i. Kill on an already-finished terminal

```json
{}
```
