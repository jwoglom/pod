# Top-level build orchestration for the pod-five simulator + embedded UI.
#
# Common entry points:
#   make                — build the React UI then the Go binary (host arch)
#   make pi             — build for Raspberry Pi (linux/arm)
#   make setcap         — grant the local ./pod binary BLE capabilities
#                         (sudo password required). Run on the Pi after the
#                         binary is in place; lets you run ./pod without sudo.
#   make run            — pi build + setcap in one shot (run on the Pi)
#   make frontend-build — npm install + npm run build only
#   make frontend-dev   — start the React dev server (live reload)
#   make clean          — remove build artifacts

.PHONY: all pi run setcap frontend-install frontend-build frontend-dev go-build clean

all: frontend-build go-build

pi: frontend-build
	GOOS=linux GOARCH=arm go build -o pod ./

# Grants cap_net_raw + cap_net_admin to ./pod so it can open hci0 without
# being run as root. Linux-only; will fail with a clear error elsewhere.
setcap:
	@if [ ! -x ./pod ]; then \
		echo "make setcap: ./pod not found — run \`make pi\` (on the Pi) first" >&2; \
		exit 1; \
	fi
	sudo setcap 'cap_net_raw,cap_net_admin=eip' ./pod

# Convenience target for the on-the-Pi workflow: build, then setcap.
run: pi setcap

frontend-install:
	cd frontend && npm install

frontend-build: frontend-install
	cd frontend && npm run build
	# Vite's emptyOutDir wipes the directory; restore the placeholder so
	# subsequent `git status` and a later `make clean` round-trip stay
	# consistent.
	touch frontend/build/.placeholder

frontend-dev:
	cd frontend && npm run dev

go-build:
	go build -o pod ./

clean:
	rm -f pod
	rm -rf frontend/build/*
	touch frontend/build/.placeholder
