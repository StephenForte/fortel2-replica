.PHONY: test

test:
	python3 -m unittest discover -s tests -v

.PHONY: bridge-config

bridge-config:
	python3 scripts/gen-bridge-config.py
