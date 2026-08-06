tests:
	- cmd: echo hi
	  outputs:
		stdout:
			- hi
		!stdout:
			- boom
		files:
			out.txt:
				exists: true
		!files:
			stray.txt: {}
