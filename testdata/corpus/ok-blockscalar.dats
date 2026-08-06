tests:
	- cmd: bash {inputs.s.sh}
	  inputs:
		files:
			s.sh: |
				echo a: b
