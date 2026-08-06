setup: echo a
teardown:
	- echo b
	- cmd: echo c
	  timeout: 2s
tests:
	- cmd: echo hi
