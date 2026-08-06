tests:
	- cmd: echo hi
	  inputs:
		files:
			a.txt: x
		copy:
			a.txt: y
