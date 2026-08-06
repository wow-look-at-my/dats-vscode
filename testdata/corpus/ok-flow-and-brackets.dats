tests:
	- cmd: awk "{print $1}" f
	  outputs:
		stdout: [hi, there]
