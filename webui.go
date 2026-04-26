package main

import (
	"embed"
	"io/fs"
	"net/http"
)

// webUIFS holds the production build of the React UI embedded at compile
// time. Run `make frontend-build` first; without that, the directory only
// contains a .placeholder file and the served UI will 404.
//
//go:embed all:frontend/build
var webUIFS embed.FS

// webUIHandler returns an http.Handler that serves the embedded React build
// from frontend/build/. Returns nil if the embed could not be subrooted —
// callers should treat nil as "no UI bundled" and fall back accordingly.
func webUIHandler() http.Handler {
	sub, err := fs.Sub(webUIFS, "frontend/build")
	if err != nil {
		return nil
	}
	return http.FileServer(http.FS(sub))
}
