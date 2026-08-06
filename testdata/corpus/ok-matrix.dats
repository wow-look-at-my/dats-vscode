tests:
	- cmd: echo {matrix.n}
	  matrix:
		n: [1, 2]
