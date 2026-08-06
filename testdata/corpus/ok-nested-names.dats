tests:
	- cmd: echo hi
	  inputs:
		files:
			sub/a.txt: x
	  outputs:
		files:
			sub/b.txt: {}
