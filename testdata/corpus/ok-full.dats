# Every construct the CLI accepts, in one file -- the corpus entry that proves
# the validator stays quiet on a whole valid file, not just on small fragments.
sandbox:
	enabled: true
	network: false
	image: alpine:3.20

shared:
	files:
		config.json: |
			{"debug": true}
	copy:
		helper.sh: fixtures/helper.sh

setup:
	- cat {shared.config.json}
	- cmd: cat
	  stdin_file: fixtures/seed.txt
	  timeout: 5s
	  env:
		SEED: from-setup

teardown:
	- rm -f {shared.generated.txt}

tests:
	- desc: everything
	  cmd: cp {inputs.data.txt} {outputs.copy.txt}
	  exit: EXIT_SUCCESS
	  timeout: 500ms
	  inputs:
		stdin: "hello"
		files:
			data.txt: content
		copy:
			real.bin: fixtures/real.bin
		env:
			MY_VAR: "{inputs.data.txt}"
	  outputs:
		stdout:
			- "copied"
		stderr:
			0: "^warning"
		!stdout:
			- "error"
		!stderr:
			- "fatal"
		files:
			copy.txt:
				exists: true
				match:
					- "content"
				notMatch:
					- "garbage"
		!files:
			stray.txt:
				exists: true

	- desc: parameterized
	  cmd: echo {matrix.greeting} {matrix.name}
	  matrix:
		greeting: [hello, howdy]
		name: [alice]
	  inputs:
		copy:
			fixture.bin: fixtures/{matrix.name}.bin
	  outputs:
		snapshot:
			stdout: true

	- desc: json
	  cmd: echo '{"ok": true}'
	  outputs:
		json_output:
			ok: true
