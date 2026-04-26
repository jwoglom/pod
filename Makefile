# Top-level build orchestration for the pod-five simulator + embedded UI.
#
# Common entry points:
#   make             — build the React UI then the Go binary (host arch)
#   make pi          — build for Raspberry Pi (linux/arm)
#   make frontend-build — npm install + npm run build only
#   make frontend-dev   — start the React dev server (live reload)
#   make clean       — remove build artifacts

.PHONY: all pi frontend-install frontend-build frontend-dev go-build clean

all: frontend-build go-build

pi: frontend-build
	GOOS=linux GOARCH=arm go build -o pod ./

frontend-install:
	cd frontend && npm ci

frontend-build: frontend-install
	cd frontend && npm run build

frontend-dev:
	cd frontend && npm start

go-build:
	go build -o pod ./

clean:
	rm -f pod
	rm -rf frontend/build/*
	touch frontend/build/.placeholder
