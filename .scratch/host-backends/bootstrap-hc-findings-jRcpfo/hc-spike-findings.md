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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-idle-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767977549,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-min-idle-st",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 29701
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-idle-st",
        "notify": false,
        "parent": null,
        "pid": 29701,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-idle-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767977549,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-min-idle-st",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 29701
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-idle-st",
        "notify": false,
        "parent": null,
        "pid": 29701,
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
        "status_ms": 1795767977654,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t2\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-min-idle-st\",\"state\":\"live\",\"status\":\"idle\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t2",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767977654,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-working-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767977693,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-working-st",
        "notify": false,
        "parent": null,
        "pid": 29736,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-working-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767977693,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-working-st",
        "notify": false,
        "parent": null,
        "pid": 29736,
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
        "status_ms": 1795767977797,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t3\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-min-working-st\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t3",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-min-working-st",
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
        "status_ms": 1795767977797,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-done-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767977837,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-done-st",
        "notify": false,
        "parent": null,
        "pid": 29770,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-done-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767977837,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-done-st",
        "notify": false,
        "parent": null,
        "pid": 29770,
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
        "status_ms": 1795767977942,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t4\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-min-done-st\",\"state\":\"live\",\"status\":\"done\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t4",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767977942,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-blocked-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767977981,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-blocked-st",
        "notify": false,
        "parent": null,
        "pid": 29805,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-blocked-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767977981,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-blocked-st",
        "notify": false,
        "parent": null,
        "pid": 29805,
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
        "status_ms": 1795767978070,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t5\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-min-blocked-st\",\"state\":\"live\",\"status\":\"blocked\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t5",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-min-blocked-st",
        "state": "live",
        "status": "blocked",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 2,
      "statusChanged": true,
      "accepted": true,
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": {
          "state": "blocked"
        },
        "status_ms": 1795767978070,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-error-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978126,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-error-st",
        "notify": false,
        "parent": null,
        "pid": 29839,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-error-st",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978126,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-error-st",
        "notify": false,
        "parent": null,
        "pid": 29839,
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
        "status_ms": 1795767978230,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t6\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-min-error-st\",\"state\":\"live\",\"status\":\"error\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t6",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767978230,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-working-bel",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978270,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-working-bel",
        "notify": false,
        "parent": null,
        "pid": 29873,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-working-bel",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978270,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-working-bel",
        "notify": false,
        "parent": null,
        "pid": 29873,
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
        "status_ms": 1795767978370,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t7\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-min-working-bel\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t7",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767978370,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-blocked-bel",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978413,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-blocked-bel",
        "notify": false,
        "parent": null,
        "pid": 29907,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-min-blocked-bel",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978413,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-min-blocked-bel",
        "notify": false,
        "parent": null,
        "pid": 29907,
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
        "status_ms": 1795767978514,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t8\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-min-blocked-bel\",\"state\":\"live\",\"status\":\"blocked\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t8",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-min-blocked-bel",
        "state": "live",
        "status": "blocked",
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
          "state": "blocked"
        },
        "status_ms": 1795767978514,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-app",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978559,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-key-app",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 29941
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-app",
        "notify": false,
        "parent": null,
        "pid": 29941,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-app",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978559,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-key-app",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 29941
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-app",
        "notify": false,
        "parent": null,
        "pid": 29941,
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
        "status_ms": 1795767978662,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t9\",\"agent\":\"spike\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-key-app\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t9",
        "agent": "spike",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767978662,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-msg",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978702,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-msg",
        "notify": false,
        "parent": null,
        "pid": 29976,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-msg",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767978702,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-key-msg",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 29976
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-msg",
        "notify": false,
        "parent": null,
        "pid": 29976,
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
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t10\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-key-msg\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t10",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-message",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767979345,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-message",
        "notify": false,
        "parent": null,
        "pid": 30058,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-message",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767979345,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-message",
        "notify": false,
        "parent": null,
        "pid": 30058,
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
        "status_ms": 1795767979432,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t11\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-key-message\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t11",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767979432,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-title",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767979489,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-title",
        "notify": false,
        "parent": null,
        "pid": 30093,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-title",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767979489,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-key-title",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 30093
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-title",
        "notify": false,
        "parent": null,
        "pid": 30093,
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
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t12\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-key-title\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t12",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-progress",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980132,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-progress",
        "notify": false,
        "parent": null,
        "pid": 30176,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-progress",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980132,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-progress",
        "notify": false,
        "parent": null,
        "pid": 30176,
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
        "status_ms": 1795767980218,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t13\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-key-progress\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t13",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767980218,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-kind",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980275,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-kind",
        "notify": false,
        "parent": null,
        "pid": 30210,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-kind",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980275,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-kind",
        "notify": false,
        "parent": null,
        "pid": 30210,
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
        "status_ms": 1795767980378,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t14\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-key-kind\",\"state\":\"live\",\"status\":\"blocked\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t14",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-key-kind",
        "state": "live",
        "status": "blocked",
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
          "kind": "permission",
          "state": "blocked"
        },
        "status_ms": 1795767980378,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-id",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980418,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-id",
        "notify": false,
        "parent": null,
        "pid": 30244,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-key-id",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980418,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-key-id",
        "notify": false,
        "parent": null,
        "pid": 30244,
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
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t15\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-key-id\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t15",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
        "osc-mod-hermes",
        "read"
      ],
      "cols": 200,
      "created_ms": 1795767980560,
      "cwd": "/tmp/bootstrap-hc-dyT9NX",
      "die_with_parent": false,
      "exit_code": null,
      "finished_ms": null,
      "foreground": {
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-mod-hermes",
          "read"
        ],
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "node-MainThread",
        "pid": 30278
      },
      "identity": "ghostty",
      "keep": false,
      "labels": {},
      "name": "osc-mod-hermes",
      "notify": false,
      "parent": null,
      "pid": 30278,
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
        "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
        "osc-mod-hermes",
        "read"
      ],
      "cols": 200,
      "created_ms": 1795767980560,
      "cwd": "/tmp/bootstrap-hc-dyT9NX",
      "die_with_parent": false,
      "exit_code": null,
      "finished_ms": null,
      "foreground": {
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-mod-hermes",
          "read"
        ],
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "node-MainThread",
        "pid": 30278
      },
      "identity": "ghostty",
      "keep": false,
      "labels": {},
      "name": "osc-mod-hermes",
      "notify": false,
      "parent": null,
      "pid": 30278,
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
      "status_ms": 1795767980662,
      "template": null,
      "title": "",
      "turn": 0
    },
    "ls": {
      "code": 0,
      "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t16\",\"agent\":\"hermes\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-mod-hermes\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
      "stderr": "",
      "timedOut": false
    },
    "lsTerminal": {
      "address": "t16",
      "agent": "hermes",
      "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
      "status_ms": 1795767980662,
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
  "piProgramStatus": {
    "blocked": {
      "address": "t1f",
      "terminalName": "osc-pi-blocked",
      "wire": {
        "hex": "1b5d373530313b73746174653d626c6f636b65643a6170703d70693a6b696e643d617574683a6d73673d5447396e49476c75494852764948673d1b5c",
        "utf8": "\u001b]7501;state=blocked:app=pi:kind=auth:msg=TG9nIGluIHRvIHg=\u001b\\"
      },
      "before": {
        "address": "t1f",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-blocked",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981559,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-pi-blocked",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 30528
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-blocked",
        "notify": false,
        "parent": null,
        "pid": 30528,
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
        "address": "t1f",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-blocked",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981559,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-pi-blocked",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 30528
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-blocked",
        "notify": false,
        "parent": null,
        "pid": 30528,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "app": "pi",
          "kind": "auth",
          "msg": "Log in to x",
          "state": "blocked"
        },
        "status_ms": 1795767981645,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1f\",\"agent\":\"pi\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-pi-blocked\",\"state\":\"live\",\"status\":\"blocked\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1f",
        "agent": "pi",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-pi-blocked",
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
          "app": "pi",
          "kind": "auth",
          "msg": "Log in to x",
          "state": "blocked"
        },
        "status_ms": 1795767981645,
        "turn": 0,
        "records": null,
        "lsStatus": "blocked"
      },
      "observedFields": {
        "state": "blocked",
        "app": "pi",
        "msg": "Log in to x",
        "message": null,
        "title": null,
        "progress": null,
        "kind": "auth",
        "records": null
      }
    },
    "blocked-permission": {
      "address": "t1g",
      "terminalName": "osc-pi-blocked-permission",
      "wire": {
        "hex": "1b5d373530313b73746174653d626c6f636b65643a6170703d70693a6b696e643d7065726d697373696f6e3a6d73673d513239755a6d6c7962534268593352706232343d1b5c",
        "utf8": "\u001b]7501;state=blocked:app=pi:kind=permission:msg=Q29uZmlybSBhY3Rpb24=\u001b\\"
      },
      "before": {
        "address": "t1g",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-blocked-permission",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981702,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-blocked-permission",
        "notify": false,
        "parent": null,
        "pid": 30563,
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
        "address": "t1g",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-blocked-permission",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981702,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-blocked-permission",
        "notify": false,
        "parent": null,
        "pid": 30563,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "app": "pi",
          "kind": "permission",
          "msg": "Confirm action",
          "state": "blocked"
        },
        "status_ms": 1795767981807,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1g\",\"agent\":\"pi\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-pi-blocked-permission\",\"state\":\"live\",\"status\":\"blocked\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1g",
        "agent": "pi",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-pi-blocked-permission",
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
          "app": "pi",
          "kind": "permission",
          "msg": "Confirm action",
          "state": "blocked"
        },
        "status_ms": 1795767981807,
        "turn": 0,
        "records": null,
        "lsStatus": "blocked"
      },
      "observedFields": {
        "state": "blocked",
        "app": "pi",
        "msg": "Confirm action",
        "message": null,
        "title": null,
        "progress": null,
        "kind": "permission",
        "records": null
      }
    },
    "blocked-question": {
      "address": "t1h",
      "terminalName": "osc-pi-blocked-question",
      "wire": {
        "hex": "1b5d373530313b73746174653d626c6f636b65643a6170703d70693a6b696e643d7175657374696f6e3a6d73673d5132687662334e6c494746754947397764476c7662673d3d1b5c",
        "utf8": "\u001b]7501;state=blocked:app=pi:kind=question:msg=Q2hvb3NlIGFuIG9wdGlvbg==\u001b\\"
      },
      "before": {
        "address": "t1h",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-blocked-question",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981845,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-blocked-question",
        "notify": false,
        "parent": null,
        "pid": 30597,
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
        "address": "t1h",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-blocked-question",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981845,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-blocked-question",
        "notify": false,
        "parent": null,
        "pid": 30597,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "app": "pi",
          "kind": "question",
          "msg": "Choose an option",
          "state": "blocked"
        },
        "status_ms": 1795767981946,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1h\",\"agent\":\"pi\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-pi-blocked-question\",\"state\":\"live\",\"status\":\"blocked\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1h",
        "agent": "pi",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-pi-blocked-question",
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
          "app": "pi",
          "kind": "question",
          "msg": "Choose an option",
          "state": "blocked"
        },
        "status_ms": 1795767981946,
        "turn": 0,
        "records": null,
        "lsStatus": "blocked"
      },
      "observedFields": {
        "state": "blocked",
        "app": "pi",
        "msg": "Choose an option",
        "message": null,
        "title": null,
        "progress": null,
        "kind": "question",
        "records": null
      }
    },
    "working": {
      "address": "t1j",
      "terminalName": "osc-pi-working",
      "wire": {
        "hex": "1b5d373530313b73746174653d776f726b696e673a6170703d70693a6d73673d55476b676332567a63326c7662673d3d1b5c",
        "utf8": "\u001b]7501;state=working:app=pi:msg=UGkgc2Vzc2lvbg==\u001b\\"
      },
      "before": {
        "address": "t1j",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-working",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981988,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-working",
        "notify": false,
        "parent": null,
        "pid": 30631,
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
        "address": "t1j",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-working",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981988,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-working",
        "notify": false,
        "parent": null,
        "pid": 30631,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "app": "pi",
          "msg": "Pi session",
          "state": "working"
        },
        "status_ms": 1795767982092,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1j\",\"agent\":\"pi\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-pi-working\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1j",
        "agent": "pi",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-pi-working",
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
          "app": "pi",
          "msg": "Pi session",
          "state": "working"
        },
        "status_ms": 1795767982092,
        "turn": 0,
        "records": null,
        "lsStatus": "working"
      },
      "observedFields": {
        "state": "working",
        "app": "pi",
        "msg": "Pi session",
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "done": {
      "address": "t1k",
      "terminalName": "osc-pi-done",
      "wire": {
        "hex": "1b5d373530313b73746174653d646f6e653a6170703d70693a6d73673d55476b676332567a63326c7662673d3d1b5c",
        "utf8": "\u001b]7501;state=done:app=pi:msg=UGkgc2Vzc2lvbg==\u001b\\"
      },
      "before": {
        "address": "t1k",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-done",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767982131,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-done",
        "notify": false,
        "parent": null,
        "pid": 30665,
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
        "address": "t1k",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-done",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767982131,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-done",
        "notify": false,
        "parent": null,
        "pid": 30665,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "app": "pi",
          "msg": "Pi session",
          "state": "done"
        },
        "status_ms": 1795767982220,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1k\",\"agent\":\"pi\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-pi-done\",\"state\":\"live\",\"status\":\"done\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1k",
        "agent": "pi",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-pi-done",
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
          "app": "pi",
          "msg": "Pi session",
          "state": "done"
        },
        "status_ms": 1795767982220,
        "turn": 0,
        "records": null,
        "lsStatus": "done"
      },
      "observedFields": {
        "state": "done",
        "app": "pi",
        "msg": "Pi session",
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "error": {
      "address": "t1m",
      "terminalName": "osc-pi-error",
      "wire": {
        "hex": "1b5d373530313b73746174653d6572726f723a6170703d70693a6d73673d526d46706247566b494739755932553d1b5c",
        "utf8": "\u001b]7501;state=error:app=pi:msg=RmFpbGVkIG9uY2U=\u001b\\"
      },
      "before": {
        "address": "t1m",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-error",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767982275,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-error",
        "notify": false,
        "parent": null,
        "pid": 30699,
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
        "address": "t1m",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-error",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767982275,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-error",
        "notify": false,
        "parent": null,
        "pid": 30699,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "app": "pi",
          "msg": "Failed once",
          "state": "error"
        },
        "status_ms": 1795767982377,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1m\",\"agent\":\"pi\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-pi-error\",\"state\":\"live\",\"status\":\"error\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1m",
        "agent": "pi",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-pi-error",
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
          "app": "pi",
          "msg": "Failed once",
          "state": "error"
        },
        "status_ms": 1795767982377,
        "turn": 0,
        "records": null,
        "lsStatus": "error"
      },
      "observedFields": {
        "state": "error",
        "app": "pi",
        "msg": "Failed once",
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "idle": {
      "address": "t1n",
      "terminalName": "osc-pi-idle",
      "wire": {
        "hex": "1b5d373530313b73746174653d69646c653a6170703d70691b5c",
        "utf8": "\u001b]7501;state=idle:app=pi\u001b\\"
      },
      "before": {
        "address": "t1n",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-idle",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767982417,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-idle",
        "notify": false,
        "parent": null,
        "pid": 30734,
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
        "address": "t1n",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-idle",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767982417,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-idle",
        "notify": false,
        "parent": null,
        "pid": 30734,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "app": "pi",
          "state": "idle"
        },
        "status_ms": 1795767982504,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1n\",\"agent\":\"pi\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-pi-idle\",\"state\":\"live\",\"status\":\"idle\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1n",
        "agent": "pi",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-pi-idle",
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
          "app": "pi",
          "state": "idle"
        },
        "status_ms": 1795767982504,
        "turn": 0,
        "records": null,
        "lsStatus": "idle"
      },
      "observedFields": {
        "state": "idle",
        "app": "pi",
        "msg": null,
        "message": null,
        "title": null,
        "progress": null,
        "kind": null,
        "records": null
      }
    },
    "clear": {
      "address": "t1p",
      "terminalName": "osc-pi-clear",
      "wire": {
        "hex": "1b5d373530313b73746174653d636c6561721b5c",
        "utf8": "\u001b]7501;state=clear\u001b\\"
      },
      "before": {
        "address": "t1p",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-clear",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767982562,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-pi-clear",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 30768
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-clear",
        "notify": false,
        "parent": null,
        "pid": 30768,
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
      "seed": {
        "address": "t1p",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-clear",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767982562,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-pi-clear",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 30768
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-clear",
        "notify": false,
        "parent": null,
        "pid": 30768,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": {
          "app": "pi",
          "state": "idle"
        },
        "status_ms": 1795767982663,
        "template": null,
        "title": "",
        "turn": 0
      },
      "after": {
        "address": "t1p",
        "argv": [
          "/usr/bin/node",
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-pi-clear",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767982562,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "foreground": {
          "argv": [
            "/usr/bin/node",
            "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
            "osc-pi-clear",
            "read"
          ],
          "cwd": "/tmp/bootstrap-hc-dyT9NX",
          "name": "node-MainThread",
          "pid": 30768
        },
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-pi-clear",
        "notify": false,
        "parent": null,
        "pid": 30768,
        "reason": null,
        "reported": true,
        "rm": false,
        "rows": 120,
        "screen": "exact",
        "signal": null,
        "state": "live",
        "status": null,
        "status_ms": 1795767982703,
        "template": null,
        "title": "",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 3,
      "statusChanged": true,
      "accepted": true,
      "clearMatch": "null_status",
      "acceptedAny": true,
      "representation": {
        "reported": true,
        "status": null,
        "status_ms": 1795767982703,
        "turn": 0,
        "records": null
      },
      "observedFields": {
        "state": null,
        "app": null,
        "msg": null
      },
      "seedAccepted": true
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-spaces",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980703,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-spaces",
        "notify": false,
        "parent": null,
        "pid": 30312,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-spaces",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980703,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-spaces",
        "notify": false,
        "parent": null,
        "pid": 30312,
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
        "status_ms": 1795767980808,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t17\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-esc-spaces\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t17",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767980808,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-colon",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980845,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-colon",
        "notify": false,
        "parent": null,
        "pid": 30346,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-colon",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980845,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-colon",
        "notify": false,
        "parent": null,
        "pid": 30346,
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
        "status_ms": 1795767980946,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t18\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-esc-colon\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t18",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-esc-colon",
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
        "status_ms": 1795767980946,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-unicode",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980989,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-unicode",
        "notify": false,
        "parent": null,
        "pid": 30381,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-unicode",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767980989,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-unicode",
        "notify": false,
        "parent": null,
        "pid": 30381,
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
        "status_ms": 1795767981075,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t19\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-esc-unicode\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t19",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767981075,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-percent",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981131,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-percent",
        "notify": false,
        "parent": null,
        "pid": 30415,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-esc-percent",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981131,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-esc-percent",
        "notify": false,
        "parent": null,
        "pid": 30415,
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
        "status_ms": 1795767981233,
        "template": null,
        "title": "",
        "turn": 0
      },
      "ls": {
        "code": 0,
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1b\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-esc-percent\",\"state\":\"live\",\"status\":\"working\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1b",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
        "status_ms": 1795767981233,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-rec-state-first",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981273,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-rec-state-first",
        "notify": false,
        "parent": null,
        "pid": 30449,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-rec-state-first",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981273,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-rec-state-first",
        "notify": false,
        "parent": null,
        "pid": 30449,
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
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1c\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-rec-state-first\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1c",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-rec-id-first",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981415,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-rec-id-first",
        "notify": false,
        "parent": null,
        "pid": 30494,
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
          "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
          "osc-rec-id-first",
          "read"
        ],
        "cols": 200,
        "created_ms": 1795767981415,
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "die_with_parent": false,
        "exit_code": null,
        "finished_ms": null,
        "identity": "ghostty",
        "keep": false,
        "labels": {},
        "name": "osc-rec-id-first",
        "notify": false,
        "parent": null,
        "pid": 30494,
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
        "stdout": "{\"hidden_finished\":0,\"terminals\":[{\"address\":\"t1d\",\"agent\":\"node\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"osc-rec-id-first\",\"state\":\"live\",\"turn\":0}]}\n",
        "stderr": "",
        "timedOut": false
      },
      "lsTerminal": {
        "address": "t1d",
        "agent": "node",
        "cwd": "/tmp/bootstrap-hc-dyT9NX",
        "name": "osc-rec-id-first",
        "state": "live",
        "turn": 0
      },
      "polls": 1,
      "elapsedMs": 2,
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
      "/tmp/bootstrap-hc-dyT9NX/state/herdr-core/bootstrap-hc-dyT9NX/core.log"
    ],
    "tail": [],
    "osc7501Lines": []
  },
  "realPi": {
    "command": "pi",
    "statusOverride": "unset",
    "run": {
      "code": 0,
      "stdout": "{\"address\":\"t1q\",\"agent\":\"pi\",\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"name\":\"pi-native-status\",\"state\":\"live\",\"turn\":0}\n",
      "stderr": "",
      "timedOut": false
    },
    "address": "t1q",
    "terminal": {
      "address": "t1q",
      "argv": [
        "pi"
      ],
      "cols": 200,
      "created_ms": 1795767982745,
      "cwd": "/tmp/bootstrap-hc-dyT9NX",
      "die_with_parent": false,
      "exit_code": null,
      "finished_ms": null,
      "identity": "ghostty",
      "keep": false,
      "labels": {},
      "name": "pi-native-status",
      "notify": false,
      "parent": null,
      "pid": 30802,
      "reason": null,
      "reported": true,
      "rm": false,
      "rows": 120,
      "screen": "exact",
      "signal": null,
      "state": "live",
      "status": {
        "app": "pi",
        "state": "idle"
      },
      "status_ms": 1795767983055,
      "template": null,
      "title": "",
      "turn": 0
    },
    "reported": true,
    "state": "idle",
    "app": "pi",
    "piStatusObserved": true,
    "note": "Fresh isolated HOME/XDG paths; no PI_PROGRAM_STATUS override or user input; terminal is cleaned up with the isolated core."
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
    },
    "piProgramStatus": {
      "blocked": {
        "observed": true,
        "accepted": true,
        "reported": true,
        "status": {
          "app": "pi",
          "kind": "auth",
          "msg": "Log in to x",
          "state": "blocked"
        },
        "observedFields": {
          "state": "blocked",
          "app": "pi",
          "msg": "Log in to x",
          "message": null,
          "title": null,
          "progress": null,
          "kind": "auth",
          "records": null
        }
      },
      "blocked-permission": {
        "observed": true,
        "accepted": true,
        "reported": true,
        "status": {
          "app": "pi",
          "kind": "permission",
          "msg": "Confirm action",
          "state": "blocked"
        },
        "observedFields": {
          "state": "blocked",
          "app": "pi",
          "msg": "Confirm action",
          "message": null,
          "title": null,
          "progress": null,
          "kind": "permission",
          "records": null
        }
      },
      "blocked-question": {
        "observed": true,
        "accepted": true,
        "reported": true,
        "status": {
          "app": "pi",
          "kind": "question",
          "msg": "Choose an option",
          "state": "blocked"
        },
        "observedFields": {
          "state": "blocked",
          "app": "pi",
          "msg": "Choose an option",
          "message": null,
          "title": null,
          "progress": null,
          "kind": "question",
          "records": null
        }
      },
      "working": {
        "observed": true,
        "accepted": true,
        "reported": true,
        "status": {
          "app": "pi",
          "msg": "Pi session",
          "state": "working"
        },
        "observedFields": {
          "state": "working",
          "app": "pi",
          "msg": "Pi session",
          "message": null,
          "title": null,
          "progress": null,
          "kind": null,
          "records": null
        }
      },
      "done": {
        "observed": true,
        "accepted": true,
        "reported": true,
        "status": {
          "app": "pi",
          "msg": "Pi session",
          "state": "done"
        },
        "observedFields": {
          "state": "done",
          "app": "pi",
          "msg": "Pi session",
          "message": null,
          "title": null,
          "progress": null,
          "kind": null,
          "records": null
        }
      },
      "error": {
        "observed": true,
        "accepted": true,
        "reported": true,
        "status": {
          "app": "pi",
          "msg": "Failed once",
          "state": "error"
        },
        "observedFields": {
          "state": "error",
          "app": "pi",
          "msg": "Failed once",
          "message": null,
          "title": null,
          "progress": null,
          "kind": null,
          "records": null
        }
      },
      "idle": {
        "observed": true,
        "accepted": true,
        "reported": true,
        "status": {
          "app": "pi",
          "state": "idle"
        },
        "observedFields": {
          "state": "idle",
          "app": "pi",
          "msg": null,
          "message": null,
          "title": null,
          "progress": null,
          "kind": null,
          "records": null
        }
      },
      "clear": {
        "observed": true,
        "seedAccepted": true,
        "accepted": true,
        "clearMatch": "null_status",
        "reported": true,
        "status": null
      }
    },
    "realPi": {
      "observed": true,
      "reported": true,
      "app": "pi",
      "state": "idle",
      "piStatusObserved": true
    }
  }
}
```

## c. Core isolation and teardown

```json
{
  "root": "/tmp/bootstrap-hc-dyT9NX",
  "env": {
    "LANG": "en_US.UTF-8",
    "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
    "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
    "HC_SESSION": "bootstrap-hc-dyT9NX",
    "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
    "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
    "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
    "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
    "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state",
    "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
    "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
    "SHELL": "/bin/sh",
    "TERM": "xterm-256color"
  },
  "shimDir": "/tmp/bootstrap-hc-dyT9NX/bin",
  "shimLogPath": "/tmp/bootstrap-hc-dyT9NX/shim-calls.log",
  "stopCommand": "env -i HC_SESSION='bootstrap-hc-dyT9NX' HC_SOCKET='/tmp/bootstrap-hc-dyT9NX/runtime/core.sock' HOME='/tmp/bootstrap-hc-dyT9NX/home' LANG='en_US.UTF-8' PATH='/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin' SHELL='/bin/sh' TERM='xterm-256color' TMPDIR='/tmp/bootstrap-hc-dyT9NX/tmp' XDG_CACHE_HOME='/tmp/bootstrap-hc-dyT9NX/cache' XDG_CONFIG_HOME='/tmp/bootstrap-hc-dyT9NX/config' XDG_DATA_HOME='/tmp/bootstrap-hc-dyT9NX/data' XDG_RUNTIME_DIR='/tmp/bootstrap-hc-dyT9NX/runtime' XDG_STATE_HOME='/tmp/bootstrap-hc-dyT9NX/state' hc server stop --json",
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
      "HC_SCOPE": "350167-b9edfb6a219ac54a4703dfa12dd7564d",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-min-idle-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350257-3980e0d71b572a5c3bef014fbe8b7a2c",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t2",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-min-working-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350271-6b4a27978ec363e40da3a1bf5fcaea8f",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t3",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-min-done-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350286-ee36660ee9720356b782c4ec7ff5118d",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t4",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-min-blocked-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350300-9e67107233d745c77256096fe2284570",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t5",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-min-error-st": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350315-e8cf08f6c5e242037cdd074b44d55b21",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t6",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-min-working-bel": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350329-d9a9934f26f05b4972580c90f5e1f85b",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t7",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-min-blocked-bel": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350343-87704ce6a034343ecbec0d5d2023c702",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t8",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-key-app": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350358-80043a8c1e8918ff5fae237ae32bcc86",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t9",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-key-msg": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350372-79272356ba004625c08d13f8cd51e53e",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t10",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-key-message": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350437-4d8da14ad4d49a4dcfc20306b6200666",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t11",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-key-title": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350451-c585d1d66d184cdb616beb9203440470",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t12",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-key-progress": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350515-d4a39c0c7c8d781712a625e14dbc6dbf",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t13",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-key-kind": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350530-fb98691568daf29a033dc89a55669721",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t14",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-key-id": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350544-66206253103a191b04b2340ef7f14f1c",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t15",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-mod-hermes": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350558-af4d228ed002cf1e2d4e18ecd95d27a4",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t16",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-esc-spaces": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350572-03218dc9aab6087eb073e0446e075d4e",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t17",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-esc-colon": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350587-2b9c0d3e5b5ffef4b2fcbc219a1fa7d7",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t18",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-esc-unicode": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350601-641caf9c324ef8081ce47d8696b7373b",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t19",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-esc-percent": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350615-1a11a66a0f4f3d3b9349692e3efb06f8",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1b",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-rec-state-first": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350629-8b3340e3e142cce96e0cf6b0c0138f9d",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1c",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-rec-id-first": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350644-37efa60a1fd56a0e06d53467489cd9d9",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1d",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-pi-blocked": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350658-c72cd35a569ff85722cb384016ac8f93",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1f",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-pi-blocked-permission": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350672-f993af44de2421464b3d50761392a04f",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1g",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-pi-blocked-question": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350686-191d16d0fe601ffab56edc5896edd688",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1h",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-pi-working": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350701-8b97b1a6f1728187ea650d3057ae6149",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1j",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-pi-done": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350715-c0da92330de56b0f22c1e6622ec8a889",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1k",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-pi-error": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350730-a0873f6d3cb4ad51c10456bc00561bd7",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1m",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-pi-idle": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350744-fdba2fcc7b8f121fc46c8231d4034237",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1n",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "osc-pi-clear": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350758-cc72913d37935422aae0c509716ae1b5",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1p",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "send-blocked": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "350808-0b5bb1354d3b95a7e4d9a2fd1fc6dc7b",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1r",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "send-working": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "351408-4aa5e4fd62159a5f6b07e590a360d9e8",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1s",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "send-done": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "351519-96766142c7df8926929d1acf20e8561d",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1t",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    },
    "send-pi-blocked": {
      "COLORTERM": "truecolor",
      "HC_SCOPE": "352135-42c2c166d7e35012728704a035df63a1",
      "HC_SESSION": "bootstrap-hc-dyT9NX",
      "HC_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HC_TERMINAL_ID": "t1v",
      "HC_TERMINAL_SOCKET": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
      "HOME": "/tmp/bootstrap-hc-dyT9NX/home",
      "LANG": "en_US.UTF-8",
      "PATH": "/tmp/bootstrap-hc-dyT9NX/bin:/home/deplague/.local/bin:/usr/bin:/bin",
      "SHELL": "/bin/sh",
      "TERM": "xterm-256color",
      "TERM_PROGRAM": "ghostty",
      "TMPDIR": "/tmp/bootstrap-hc-dyT9NX/tmp",
      "XDG_CACHE_HOME": "/tmp/bootstrap-hc-dyT9NX/cache",
      "XDG_CONFIG_HOME": "/tmp/bootstrap-hc-dyT9NX/config",
      "XDG_DATA_HOME": "/tmp/bootstrap-hc-dyT9NX/data",
      "XDG_RUNTIME_DIR": "/tmp/bootstrap-hc-dyT9NX/runtime",
      "XDG_STATE_HOME": "/tmp/bootstrap-hc-dyT9NX/state"
    }
  },
  "startResult": {
    "code": 0,
    "stdout": "{\"core\":{\"id\":\"c0c3f2fded259d56740a465033503de6\",\"name\":\"cachyos-x8664\"},\"finished\":0,\"holder\":null,\"holders\":[],\"installed_by\":null,\"keeps_running_after_logout\":null,\"live\":0,\"logout_linger_user\":null,\"pid\":29651,\"uptime_ms\":9,\"version\":\"0.1.22\"}\n",
    "stderr": "",
    "timedOut": false
  },
  "startPid": 29651,
  "identity": {
    "socket": "/tmp/bootstrap-hc-dyT9NX/runtime/core.sock",
    "device": 57,
    "inode": 37857,
    "id": "c0c3f2fded259d56740a465033503de6",
    "pid": 29651
  },
  "cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-ghostty-surface-transient-1705.scope",
  "hasRuntimeMarker": true,
  "observedCoreRuntimeEnv": "1",
  "cleanup": [
    {
      "address": "t1q",
      "kill": {
        "code": 0,
        "stdout": "{\"address\":\"t1q\",\"argv\":[\"pi\"],\"cols\":200,\"created_ms\":1795767982745,\"cwd\":\"/tmp/bootstrap-hc-dyT9NX\",\"die_with_parent\":false,\"exit_code\":0,\"finished_ms\":1795768002389,\"identity\":\"ghostty\",\"keep\":false,\"labels\":{},\"name\":\"pi-native-status\",\"notify\":false,\"parent\":null,\"pid\":30802,\"reason\":\"killed\",\"reported\":true,\"rm\":false,\"rows\":120,\"screen\":\"exact\",\"signal\":null,\"state\":\"finished\",\"status\":null,\"status_ms\":1795768002383,\"template\":null,\"title\":\"π - bootstrap-hc-dyT9NX\",\"turn\":0}\n",
        "stderr": "",
        "timedOut": false
      }
    },
    {
      "address": "t1q",
      "rm": {
        "code": 0,
        "stdout": "{\"removed\":\"t1q\"}\n",
        "stderr": "",
        "timedOut": false
      }
    },
    {
      "stopResult": {
        "mode": "verified",
        "stop": {
          "code": 0,
          "stdout": "{\"stopped\":true}\n",
          "stderr": "",
          "timedOut": false
        },
        "corePid": 29651,
        "holderPids": [
          29665
        ],
        "remainingCoreAlive": false,
        "remainingHolderPids": [],
        "socketRemaining": false,
        "stopped": true
      }
    }
  ],
  "corePid": 29651,
  "holderPids": [
    29665
  ],
  "teardownPids": {
    "mode": "verified",
    "corePid": 29651,
    "holderPids": [
      29665
    ],
    "remainingCoreAlive": false,
    "remainingHolderPids": [],
    "socketRemaining": false
  },
  "coreLog": {
    "files": [
      "/tmp/bootstrap-hc-dyT9NX/state/herdr-core/bootstrap-hc-dyT9NX/core.log"
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
    "stdout": "{\"core\":{\"id\":\"c0c3f2fded259d56740a465033503de6\",\"name\":\"cachyos-x8664\"},\"finished\":0,\"holder\":null,\"holders\":[],\"installed_by\":null,\"keeps_running_after_logout\":null,\"live\":0,\"logout_linger_user\":null,\"pid\":29651,\"uptime_ms\":11,\"version\":\"0.1.22\"}\n",
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
    "address": "t1r",
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
      "t1r",
      "[BOOTSTRAP_WAKE handoff=blocked]"
    ],
    "sendDurationMs": 819,
    "waited": false,
    "result": {
      "code": 9,
      "stdout": "",
      "stderr": "{\"error\":{\"hint\":\"typing would answer its dialog; read its screen first (hc read t1r), or --force\",\"kind\":\"blocked\",\"message\":\"t1r is blocked (waiting)\"}}\n",
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
    "address": "t1s",
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
      "t1s",
      "[BOOTSTRAP_WAKE handoff=working]"
    ],
    "sendDurationMs": 972,
    "waited": false,
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
    "address": "t1t",
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
      "t1t",
      "[BOOTSTRAP_WAKE handoff=done]"
    ],
    "sendDurationMs": 6021,
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
  "piBlocked": {
    "address": "t1v",
    "wire": {
      "hex": "1b5d373530313b73746174653d626c6f636b65643a6170703d70693a6b696e643d617574683a6d73673d5447396e49476c75494852764948673d1b5c",
      "utf8": "\u001b]7501;state=blocked:app=pi:kind=auth:msg=TG9nIGluIHRvIHg=\u001b\\"
    },
    "statusBefore": null,
    "after": {
      "address": "t1v",
      "argv": [
        "/usr/bin/node",
        "/home/deplague/.cache/host-backends-work/wt-07/bootstrap/test-support/hc-live-terminal.ts",
        "send-pi-blocked",
        "read"
      ],
      "cols": 200,
      "created_ms": 1795767996333,
      "cwd": "/tmp/bootstrap-hc-dyT9NX",
      "die_with_parent": false,
      "exit_code": null,
      "finished_ms": null,
      "identity": "ghostty",
      "keep": false,
      "labels": {},
      "name": "send-pi-blocked",
      "notify": false,
      "parent": null,
      "pid": 30991,
      "reason": null,
      "reported": true,
      "rm": false,
      "rows": 120,
      "screen": "exact",
      "signal": null,
      "state": "live",
      "status": {
        "app": "pi",
        "kind": "auth",
        "msg": "Log in to x",
        "state": "blocked"
      },
      "status_ms": 1795767996435,
      "template": null,
      "title": "",
      "turn": 0
    },
    "statusAfter": {
      "app": "pi",
      "kind": "auth",
      "msg": "Log in to x",
      "state": "blocked"
    },
    "statusObserved": true,
    "sendAttempted": true,
    "args": [
      "send",
      "--json",
      "t1v",
      "[BOOTSTRAP_WAKE handoff=pi-blocked]"
    ],
    "sendDurationMs": 819,
    "waited": false,
    "result": {
      "code": 9,
      "stdout": "",
      "stderr": "{\"error\":{\"hint\":\"typing would answer its dialog; read its screen first (hc read t1v), or --force\",\"kind\":\"blocked\",\"message\":\"t1v is blocked (auth)\"}}\n",
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
  "observations": {
    "blockedRefused": {
      "observed": true,
      "statusObserved": true,
      "code": 9,
      "errorKind": "blocked",
      "deliveredBytes": 0
    },
    "piBlockedReport": {
      "observed": true,
      "statusObserved": true,
      "reported": true,
      "status": {
        "app": "pi",
        "kind": "auth",
        "msg": "Log in to x",
        "state": "blocked"
      },
      "sendAttempted": true,
      "code": 9,
      "errorKind": "blocked",
      "delivered": false,
      "deliveredBytes": 0,
      "refused": true
    },
    "workingSend": {
      "observed": true,
      "code": 0,
      "delivered": true,
      "waited": false
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
