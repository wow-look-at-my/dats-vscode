tests:
	- cmd: echo hi
	  outputs:
		stdout:
			0: "^hi$"
